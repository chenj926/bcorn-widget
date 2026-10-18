package com.acorn.widget.gradesync

import android.app.Activity
import android.content.Intent
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Native boundary owns authorization, exact binding, encrypted journal and bounded foreground I/O.
 * Lifecycle generation invalidates every in-flight operation. Only an explicit Connect may show
 * native consent or create a Sheet. A changed account can never retarget an old journal.
 */
class NativeGradeSyncGateway @JvmOverloads constructor(
    private val activity: Activity,
    private val configured: Boolean,
    private val authorization: GradeAuthorization = GoogleGradeAuthorization(activity),
    private val storage: GradeSyncStorage = EncryptedGradeSyncStorage.shared(activity),
    private val transport: GradeSheetsTransport = HttpsGradeSheetsTransport(),
    private val executor: Executor = NETWORK,
    private val stateExecutor: Executor = STATE
) {
    @Volatile private var foreground = false
    @Volatile private var destroyed = false
    @Volatile private var generation = 0L
    private var accessToken: String? = null
    private var verifiedToken: String? = null
    private var accountKey: String? = null
    private var authorizationState = "authorization-required"
    private var busy = false
    private var afterResume: (() -> Unit)? = null
    private var selection: GradeSheetSelection? = null

    fun onResume() { foreground = true; authorization.setForeground(true); val waiting = afterResume; afterResume = null; waiting?.invoke() }
    fun onPause() {
        foreground = false; authorization.setForeground(false); generation += 1; accessToken = null; verifiedToken = null; accountKey = null; transport.cancel()
        // Native consent itself pauses this Activity. Keep only its continuation until onResume;
        // no SDK token or HTTP request is used while the application is backgrounded.
    }
    fun onDestroy() { destroyed = true; onPause(); afterResume = null; selection = null; authorization.close() }
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) = authorization.onActivityResult(requestCode, resultCode, data)

    fun call(method: String, arguments: JSONObject, complete: (Any?) -> Unit) {
        if (destroyed) return
        if (method !in methods) { complete(failure("invalid-request")); return }
        if (method !in setOf("loadGradeSyncState", "saveGradeSyncState") && !configured()) {
            complete(if (method == "getGradeSyncStatus") JSONObject().put("state", "not-configured").put("binding", JSONObject.NULL)
                .put("connectionId", JSONObject.NULL).put("deviceId", JSONObject.NULL).put("automaticInbound", false).put("foregroundSyncAvailable", false)
                else failure("not-configured"))
            return
        }
        // First key creation/metadata decryption runs off the UI thread; later reads use the
        // process-wide store's coherent metadata snapshot. All gateway state stays on main.
        val submitted = generation
        disk({ storage.deviceId(); storage.binding(); storage.authorizationBlocked() }, {
            if (!destroyed) {
                if (method !in setOf("loadGradeSyncState", "saveGradeSyncState") && generation != submitted) complete(failure("offline"))
                else preparedCall(method, arguments, complete)
            }
        }, { complete(failure(it)) })
    }
    private fun preparedCall(method: String, arguments: JSONObject, complete: (Any?) -> Unit) {
        try {
            require(method in methods) { "invalid-request" }
            when (method) {
                "loadGradeSyncState" -> { GradeSheetsPolicy.keys(arguments, setOf("connectionId")); val id = arguments.getString("connectionId"); local(complete) { storage.load(id) } }
                "saveGradeSyncState" -> { GradeSheetsPolicy.keys(arguments, setOf("connectionId", "envelope")); val id = arguments.getString("connectionId"); val envelope = arguments.getJSONObject("envelope"); local(complete) { storage.save(id, envelope); JSONObject().put("ok", true) } }
                "getGradeSyncStatus" -> status(complete)
                "connectGradeSheet" -> connect(arguments, complete)
                "gradeSheetsRequest" -> request(arguments, complete)
                "gradeSheetVersion" -> version(arguments, complete)
                "pickGradeSheet" -> pick(arguments, complete)
                "createMappedGradeSheet" -> createMapped(arguments, complete)
                "previewGradeSheet" -> preview(arguments, complete)
                "confirmGradeSheetMapping" -> confirmMapping(arguments, complete)
                "readMappedGradeSnapshot" -> readMapped(arguments, complete)
                "commitMappedGradeCells" -> commitMapped(arguments, complete)
            }
        } catch (error: Exception) { complete(failure(safeCode(error))) }
    }
    private fun local(complete: (Any?) -> Unit, work: () -> Any?) = disk(work, complete) { complete(failure(it)) }
    private fun <T> disk(work: () -> T, complete: (T) -> Unit, failed: (String) -> Unit) {
        stateExecutor.execute {
            try {
                val result = work()
                activity.runOnUiThread { if (!destroyed) complete(result) }
            } catch (error: Exception) {
                val code = safeCode(error, "invalid-storage")
                activity.runOnUiThread { if (!destroyed) failed(code) }
            }
        }
    }
    /** A queued consent/binding transition cannot cross a pause, unlike ordinary offline edits. */
    private fun <T> transition(work: () -> T, complete: (T) -> Unit, failed: (String) -> Unit) {
        val started = generation
        disk({
            check(foreground && !destroyed && generation == started) { "offline" }
            work()
        }, { result ->
            if (!foreground || generation != started) failed("offline") else complete(result)
        }, failed)
    }
    /** Parsing a 5,200-cell preview and validating mappings must not block WebView gestures. */
    private fun <T> process(work: () -> T, complete: (T) -> Unit, failed: (String) -> Unit) {
        val started = generation; busy = true
        disk(work, { result ->
            busy = false
            if (!foreground || generation != started) failed("offline") else complete(result)
        }, { code -> busy = false; failed(code) })
    }
    private fun configured() = configured && authorization.available()
    private fun statusJson(): JSONObject {
        val binding = storage.binding()
        val state = if (!configured()) "not-configured" else if (binding == null || storage.authorizationBlocked()) "authorization-required" else authorizationState
        return JSONObject().put("state", state).put("binding", binding?.publicJson() ?: JSONObject.NULL)
            .put("connectionId", binding?.connectionId ?: JSONObject.NULL).put("deviceId", storage.deviceId())
            .put("automaticInbound", false).put("foregroundSyncAvailable", configured() && foreground && state == "ready")
    }
    private fun status(complete: (Any?) -> Unit) {
        if (!configured() || storage.binding() == null || storage.authorizationBlocked() || !foreground || accessToken != null || authorizationState == "revoked" || busy) { complete(statusJson()); return }
        busy = true
        authorize(false) { error ->
            busy = false
            if (error != null && error != "offline") authorizationState = if (error == "not-configured") "not-configured" else "authorization-required"
            complete(try { statusJson() } catch (_: Exception) { failure("invalid-storage") })
        }
    }
    private fun authorize(interactive: Boolean, complete: (String?) -> Unit) = acquire(interactive, false) { complete(it.error) }
    private fun acquire(interactive: Boolean, picker: Boolean, complete: (NativeAuthorizationResult) -> Unit) {
        if (!configured()) { complete(NativeAuthorizationResult(error = "not-configured")); return }
        if (!foreground) { complete(NativeAuthorizationResult(error = "offline")); return }
        val started = generation
        val received: (NativeAuthorizationResult) -> Unit = callback@ { result ->
            if (destroyed) return@callback
            val continuation: () -> Unit = {
                if (!interactive && started != generation) complete(NativeAuthorizationResult(error = "offline"))
                else if (result.error != null || result.token.isNullOrBlank()) complete(NativeAuthorizationResult(error = result.error ?: "authorization-required"))
                else verifyAccount(result, interactive, complete)
            }
            if (interactive && !foreground) afterResume = continuation else continuation()
        }
        if (picker) authorization.pickSheet(received) else authorization.authorize(interactive, received)
    }
    private fun verifyAccount(result: NativeAuthorizationResult, interactive: Boolean, complete: (NativeAuthorizationResult) -> Unit) {
        val expected = if (interactive) null else selection?.accountKey ?: storage.binding()?.accountKey
        if (!interactive && expected == null) { accessToken = null; authorizationState = "authorization-required"; complete(NativeAuthorizationResult(error = "authorization-required")); return }
        fun accept(key: String) {
            if (!interactive && key != expected) {
                accessToken = null; verifiedToken = null; accountKey = null; authorizationState = "authorization-required"
                // Never replay an old outbox under another account, even if it shares the same file.
                transition({ storage.blockAuthorization() }, { complete(NativeAuthorizationResult(error = "authorization-required")) }, { code -> complete(NativeAuthorizationResult(error = code)) })
            } else {
                accessToken = result.token; verifiedToken = result.token; accountKey = key; authorizationState = "ready"; complete(result)
            }
        }
        if (result.token == verifiedToken && accountKey != null) { accept(accountKey!!); return }
        accessToken = result.token
        perform(GradeAccountIdentity.request()) { response, code ->
            if (code != null || response == null || response.status !in 200..299) {
                accessToken = null; authorizationState = "authorization-required"; complete(NativeAuthorizationResult(error = code ?: httpCode(response?.status ?: 0))); return@perform
            }
            try { accept(GradeAccountIdentity.fingerprint(storage.deviceId(), response.body)) }
            catch (_: Exception) { accessToken = null; authorizationState = "authorization-required"; complete(NativeAuthorizationResult(error = "authorization-required")) }
        }
    }
    private fun connect(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, setOf("title", "tab"))
        val tab = arguments.getString("tab")
        val template = GradeSheetsPolicy.template(arguments.getString("title"), tab)
        if (busy) { complete(failure("busy")); return }
        if (!configured()) { complete(failure("not-configured")); return }
        if (!foreground) { complete(failure("offline")); return }
        accessToken = null; authorizationState = "authorization-required"; selection = null
        busy = true
        transition({ storage.blockAuthorization() }, {
        authorize(true) { error ->
            if (error != null) { accessToken = null; authorizationState = "authorization-required"; busy = false; complete(failure(error)); return@authorize }
            perform(SheetRequest("POST", "/v4/spreadsheets", template)) { response, code ->
                busy = false
                if (code != null) { accessToken = null; authorizationState = "authorization-required"; complete(failure(code)); return@perform }
                if (response == null || response.status !in 200..299) { accessToken = null; authorizationState = "authorization-required"; complete(failure(httpCode(response?.status ?: 0), response?.retryAfterMs ?: 0)); return@perform }
                try {
                    val id = response.body.getString("spreadsheetId")
                    require(id != storage.binding()?.spreadsheetId) { "invalid-response" }
                    val sheets = response.body.getJSONArray("sheets")
                    require(sheets.length() == 1 && sheets.getJSONObject(0).getJSONObject("properties").getString("title") == tab) { "invalid-response" }
                    val binding = GradeSheetBinding(id, tab, UUID.randomUUID().toString(), null, accountKey ?: error("authorization-required"))
                    busy = true
                    transition({ storage.bind(binding) }, { busy = false; complete(statusJson().put("ok", true)) }, { code ->
                        busy = false; accessToken = null; authorizationState = "authorization-required"; complete(failure(code))
                    })
                } catch (_: Exception) { busy = false; accessToken = null; authorizationState = "authorization-required"; complete(failure("invalid-response")) }
            }
        }
        }, { code -> busy = false; complete(failure(code)) })
    }
    private fun createMapped(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, setOf("course"))
        if (busy) { complete(failure("busy")); return }
        if (!foreground) { complete(failure("offline")); return }
        val course = JSONObject(arguments.getJSONObject("course").toString())
        process({ GradeMappedTemplate.build(course) }, { template ->
            accessToken = null; authorizationState = "authorization-required"; selection = null; busy = true
            transition({ storage.blockAuthorization() }, {
                authorize(true) auth@ { error ->
                    if (error != null) { busy = false; complete(failure(error)); return@auth }
                    perform(SheetRequest("POST", "/v4/spreadsheets", template.request())) created@ { response, code ->
                        busy = false
                        if (!successful(response, code, complete)) return@created
                        try {
                            val body = response!!.body; val fileId = body.getString("spreadsheetId"); val sheets = body.getJSONArray("sheets")
                            require(fileId != storage.binding()?.spreadsheetId && sheets.length() == 1) { "invalid-response" }
                            val properties = sheets.getJSONObject(0).getJSONObject("properties")
                            require(properties.getString("title") == template.tab) { "invalid-response" }
                            val sheetId = GradeSheetSelection.strictSheetId(properties.get("sheetId")); val mapping = template.mapping(sheetId)
                            val binding = GradeSheetBinding(fileId, template.tab, UUID.randomUUID().toString(), mapping, accountKey ?: error("authorization-required"))
                            busy = true
                            perform(mappedRequest(binding)) verify@ { observed, readCode ->
                                busy = false
                                if (!successful(observed, readCode, complete)) return@verify
                                process({ val snapshot = mappedSnapshot(binding, observed!!.body); GradeMappedSheetPolicy.confirm(fileId, mapping, snapshot); template.verifyCreated(snapshot); binding }, { confirmed ->
                                    busy = true
                                    transition({ storage.bind(confirmed) }, { busy = false; complete(statusJson().put("ok", true)) }, { saveCode -> busy = false; complete(failure(saveCode)) })
                                }, { invalid -> complete(failure(invalid)) })
                            }
                        } catch (error: Exception) { busy = false; complete(failure(safeCode(error, "invalid-response"))) }
                    }
                }
            }, { code -> busy = false; complete(failure(code)) })
        }, { code -> complete(failure(code)) })
    }
    private fun pick(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, emptySet())
        if (busy) { complete(failure("busy")); return }
        if (!foreground) { complete(failure("offline")); return }
        accessToken = null; authorizationState = "authorization-required"; selection = null; busy = true
        // Picker can select a different account. An old connection is blocked before showing it.
        transition({ storage.blockAuthorization() }, {
            acquire(true, true) { result ->
                if (result.error != null || result.pickedFileId == null) { busy = false; accessToken = null; complete(failure(result.error ?: "invalid-selection")); return@acquire }
                try {
                    val picked = GradeSheetSelection(result.pickedFileId, accountKey ?: error("authorization-required"))
                    perform(picked.metadataRequest()) { response, code ->
                        busy = false
                        if (!successful(response, code, complete)) return@perform
                        process({ picked.acceptMetadata(response!!.body) }, { metadata -> selection = picked; complete(metadata) }, { code -> complete(failure(code)) })
                    }
                } catch (error: Exception) { busy = false; complete(failure(safeCode(error, "invalid-selection"))) }
            }
        }, { code -> busy = false; complete(failure(code)) })
    }
    private fun selected(arguments: JSONObject): GradeSheetSelection {
        val current = selection ?: error("invalid-selection")
        require(arguments.getString("selectionId") == current.selectionId) { "invalid-selection" }
        return current
    }
    private fun selectedRequest(picked: GradeSheetSelection, sheetId: Int, complete: (JSONObject?, String?) -> Unit) {
        if (busy) { complete(null, "busy"); return }
        busy = true
        authorize(false) { error ->
            if (error != null || selection !== picked) { busy = false; complete(null, error ?: "invalid-selection"); return@authorize }
            perform(picked.previewRequest(sheetId)) { response, code ->
                busy = false
                if (code != null || response == null || response.status !in 200..299) { complete(null, code ?: httpCode(response?.status ?: 0)); return@perform }
                process({ GradeSheetSelection.snapshot(response.body, sheetId, picked.tab(sheetId)) }, { snapshot -> complete(snapshot, null) }, { failure -> complete(null, failure) })
            }
        }
    }
    private fun preview(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, setOf("selectionId", "sheetId"))
        val picked = selected(arguments); val sheetId = GradeSheetSelection.strictSheetId(arguments.get("sheetId")); picked.tab(sheetId)
        selectedRequest(picked, sheetId) { snapshot, code -> complete(if (code == null) snapshot else failure(code)) }
    }
    private fun confirmMapping(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, setOf("selectionId", "mapping"))
        val picked = selected(arguments); val mapping = JSONObject(arguments.getJSONObject("mapping").toString())
        require(mapping.toString().toByteArray(Charsets.UTF_8).size <= 512 * 1024) { "limit-exceeded" }
        val sheetId = GradeSheetSelection.strictSheetId(mapping.get("sheetId")); require(picked.tab(sheetId) == mapping.getString("tab")) { "invalid-mapping" }
        selectedRequest(picked, sheetId) { snapshot, code ->
            if (code != null || snapshot == null) { complete(failure(code ?: "invalid-response")); return@selectedRequest }
            process({ picked.binding(picked.policy(mapping, snapshot).mappingJson()) }, { binding ->
                busy = true
                transition({ storage.bind(binding) }, { busy = false; selection = null; complete(statusJson().put("ok", true)) }, { code -> busy = false; complete(failure(code)) })
            }, { code -> complete(failure(code)) })
        }
    }
    private fun mapped(arguments: JSONObject): GradeSheetBinding {
        val binding = storage.binding() ?: error("authorization-required")
        require(binding.connectionId == arguments.getString("connectionId")) { "connection-changed" }
        require(binding.mapping != null) { "invalid-request" }
        return binding
    }
    private fun mappedRequest(binding: GradeSheetBinding) = GradeSheetSelection.previewRequest(binding.spreadsheetId, GradeSheetSelection.strictSheetId(binding.mapping!!.get("sheetId")), binding.tab)
    private fun mappedSnapshot(binding: GradeSheetBinding, body: JSONObject) = GradeSheetSelection.snapshot(body, GradeSheetSelection.strictSheetId(binding.mapping!!.get("sheetId")), binding.tab)
    private fun readMapped(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, setOf("connectionId")); val binding = mapped(arguments)
        boundRequest(binding, mappedRequest(binding)) { response, code ->
            if (!successful(response, code, complete)) return@boundRequest
            process({ mappedSnapshot(binding, response!!.body) }, complete, { code -> complete(failure(code)) })
        }
    }
    private fun commitMapped(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, setOf("connectionId", "expectedSnapshot", "writes"))
        require(arguments.toString().toByteArray(Charsets.UTF_8).size <= GradeSheetsPolicy.MAX_BYTES) { "limit-exceeded" }
        val binding = mapped(arguments); val expected = arguments.getJSONObject("expectedSnapshot"); val writes = arguments.getJSONArray("writes")
        boundRequest(binding, mappedRequest(binding)) before@ { response, code ->
            if (!successful(response, code, complete)) return@before
            process({
                val current = mappedSnapshot(binding, response!!.body)
                val policy = GradeMappedSheetPolicy.confirm(binding.spreadsheetId, binding.mapping!!, current)
                policy to policy.prepareWrites(current, expected, writes)
            }, { (policy, write) ->
                // Sheets offers no atomic compare-and-swap. A concurrent edit can land after this
                // preflight; the adapter surfaces readback mismatch instead of claiming atomicity.
                boundRequest(binding, write) written@ { updated, updateCode ->
                    if (!successful(updated, updateCode, complete)) return@written
                    boundRequest(binding, mappedRequest(binding)) readback@ { observed, readCode ->
                        if (!successful(observed, readCode, complete)) return@readback
                        process({
                            val snapshot = mappedSnapshot(binding, observed!!.body); policy.verifyWritten(snapshot, writes); snapshot
                        }, { snapshot -> complete(JSONObject().put("ok", true).put("snapshot", snapshot)) }, { code -> complete(failure(code)) })
                    }
                }
            }, { code -> complete(failure(code)) })
        }
    }
    private fun successful(response: SheetResponse?, code: String?, complete: (Any?) -> Unit): Boolean {
        if (code != null || response == null || response.status !in 200..299) {
            complete(failure(code ?: httpCode(response?.status ?: 0), response?.retryAfterMs ?: 0)); return false
        }
        return true
    }
    private fun request(arguments: JSONObject, complete: (Any?) -> Unit) {
        // Validation precedes token acquisition: malicious requests cannot trigger consent or I/O.
        val binding = storage.binding() ?: run { complete(failure("authorization-required")); return }
        val request = GradeSheetsPolicy.validate(binding, arguments)
        boundRequest(binding, request) { response, code ->
            if (code != null) complete(failure(code))
            else if (response != null) {
                val clean = JSONObject()
                if (response.status in 200..299 && request.method == "GET") clean.put("values", response.body.optJSONArray("values") ?: org.json.JSONArray())
                complete(SheetResponse(response.status, clean, response.retryAfterMs).json())
            } else complete(failure("network-error"))
        }
    }
    private fun version(arguments: JSONObject, complete: (Any?) -> Unit) {
        GradeSheetsPolicy.keys(arguments, emptySet())
        val binding = storage.binding() ?: run { complete(failure("authorization-required")); return }
        val request = SheetRequest("GET", "/drive/v3/files/${binding.spreadsheetId}?fields=version,modifiedTime", null, "www.googleapis.com")
        boundRequest(binding, request) { response, code ->
            if (code != null) complete(failure(code))
            else if (response == null || response.status !in 200..299) complete(failure(httpCode(response?.status ?: 0), response?.retryAfterMs ?: 0))
            else {
                val version = response.body.opt("version")
                if (version !is String || !version.matches(Regex("[0-9]{1,100}"))) complete(failure("invalid-response"))
                else complete(JSONObject().put("version", version).apply {
                    val modified = response.body.opt("modifiedTime")
                    if (modified is String && modified.length <= 100) put("modifiedTime", modified)
                })
            }
        }
    }
    private fun boundRequest(binding: GradeSheetBinding, request: SheetRequest, complete: (SheetResponse?, String?) -> Unit) {
        if (busy) { complete(null, "busy"); return }
        if (!foreground) { complete(null, "offline"); return }
        if (storage.authorizationBlocked()) { complete(null, "authorization-required"); return }
        if (authorizationState == "revoked") { complete(SheetResponse(403, JSONObject()), null); return }
        busy = true
        fun send(error: String?) {
            if (error != null) { busy = false; complete(null, error); return }
            try {
                if (storage.binding()?.connectionId != binding.connectionId || storage.authorizationBlocked()) { busy = false; complete(null, "connection-changed"); return }
                perform(request) { response, code -> busy = false; complete(response, code) }
            } catch (failure: Exception) { busy = false; complete(null, safeCode(failure, "invalid-storage")) }
        }
        // The SDK caches valid access tokens and refreshes expired ones without consent.
        // Asking before each native operation avoids an hour-long foreground session using a stale token.
        authorize(false, ::send)
    }
    private fun perform(request: SheetRequest, complete: (SheetResponse?, String?) -> Unit) {
        val token = accessToken ?: run { complete(null, "authorization-required"); return }
        val started = generation
        if (!foreground) { complete(null, "offline"); return }
        executor.execute {
            var response: SheetResponse? = null
            var code: String? = null
            try {
                response = transport.execute(request, token) { foreground && !destroyed && generation == started }
                if (response?.status == 403) response = SheetResponse(GoogleGradeFailurePolicy.status(403, response?.body), JSONObject(), response?.retryAfterMs ?: 0)
            }
            catch (error: Exception) { code = if (!foreground || generation != started) "offline" else safeCode(error, "network-error") }
            activity.runOnUiThread {
                if (destroyed) return@runOnUiThread
                if (!foreground || generation != started) { complete(null, "offline"); return@runOnUiThread }
                if (response?.status == 401) {
                    accessToken = null; try { authorization.clearToken(token) } catch (_: Exception) { /* Status still blocks this request. */ }
                    authorizationState = "authorization-required"
                }
                complete(response, code)
            }
        }
    }
    companion object {
        val methods = setOf("getGradeSyncStatus", "connectGradeSheet", "gradeSheetsRequest", "gradeSheetVersion", "loadGradeSyncState", "saveGradeSyncState", "pickGradeSheet", "previewGradeSheet", "confirmGradeSheetMapping", "readMappedGradeSnapshot", "commitMappedGradeCells", "createMappedGradeSheet")
        private val STATE = Executors.newSingleThreadExecutor { Thread(it, "bcorn-grade-journal").apply { isDaemon = true } }
        private val NETWORK = Executors.newSingleThreadExecutor { Thread(it, "bcorn-grade-sheets").apply { isDaemon = true } }
        private val CODES = setOf("not-configured", "authorization-required", "revoked", "cancelled", "offline", "busy", "invalid-request", "invalid-template", "invalid-response", "invalid-storage", "limit-exceeded", "connection-changed", "network-error", "rate-limited", "relink-required", "request-failed", "invalid-selection", "invalid-mapping", "mapping-changed", "conflict")
        private fun safeCode(error: Exception, fallback: String = "invalid-request") = error.message?.takeIf { it in CODES } ?: fallback
        private fun httpCode(status: Int) = when (status) { 401 -> "authorization-required"; 403, 404 -> "relink-required"; 429 -> "rate-limited"; in 400..499 -> "request-failed"; else -> "network-error" }
        private fun failure(code: String, retryAfterMs: Long = 0) = JSONObject().put("ok", false).put("error", JSONObject().put("code", code).apply { if (retryAfterMs > 0) put("retryAfterMs", retryAfterMs) }.put("message", when (code) {
            "not-configured" -> "此版本尚未配置 Google 授权，或设备没有可用的 Google Play 服务。"
            "authorization-required" -> "请重新连接 Google 表格。"
            "revoked" -> "Google 表格访问已被撤销，请重新连接。"
            "cancelled" -> "已取消连接，原有数据保留。"
            "offline" -> "应用回到前台后会继续同步。"
            "busy" -> "同步操作正在进行，请稍后重试。"
            else -> "同步未完成，原有本地数据保留。"
        }))
    }
}
