package com.acorn.widget

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.CalendarContract
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.ValueCallback
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** A native Android host, not a replacement renderer. No background execution or network permission. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var documentRequest: String? = null
    private var exportContent: String? = null
    private var openTerm = false
    private var lastRootBackAt = 0L
    private var backPending = false
    private var lastRootBackInteraction = -1L
    private var backCallback: android.window.OnBackInvokedCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val unsupported = "Android 尚未接入 ACORN 登录和刷新。可添加课程、日程或导入本地 JSON；不会在后台联网。"
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openTerm = intent.getBooleanExtra("openTerm", false)
        web = WebView(this)
        setContentView(web)
        // Respect status/navigation bars including Android 15 edge-to-edge enforcement.
        web.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = true // User-selected document URIs for HTML file input only.
            setSupportMultipleWindows(false); javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        android.webkit.CookieManager.getInstance().setAcceptCookie(false)
        web.addJavascriptInterface(NativeBridge(), "AcornNative")
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                        .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream")), HTML_IMPORT)
                    true
                } catch (_: Exception) { fileCallback = null; callback.onReceiveValue(null); true }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                if (uri.scheme != "https" || uri.host != HOST) return blocked()
                val path = uri.path.orEmpty().removePrefix("/")
                if (path.contains("..") || (!path.startsWith("src/renderer/") && !path.startsWith("src/shared/") && path != "android-bridge.js")) return blocked()
                return try {
                    val mime = when { path.endsWith(".html") -> "text/html"; path.endsWith(".css") -> "text/css"; path.endsWith(".js") -> "application/javascript"; else -> "application/octet-stream" }
                    var bytes = assets.open(path).use { it.readBytes() }
                    if (path == "src/renderer/index.html") {
                        // Build copies the renderer byte-for-byte. Add only the native adapter while serving.
                        bytes = bytes.toString(Charsets.UTF_8).replace("<head>", "<head><script src=\"/android-bridge.js\"></script>").toByteArray(Charsets.UTF_8)
                    }
                    WebResourceResponse(mime, "UTF-8", ByteArrayInputStream(bytes))
                } catch (_: Exception) { blocked() }
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean = true
            override fun onPageFinished(view: WebView?, url: String?) {
                if (openTerm) { openTerm = false; web.evaluateJavascript("document.querySelector('[data-tab=term]')?.click()", null) }
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = android.window.OnBackInvokedCallback { handleBack() }.also {
                onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, it)
            }
        }
        web.loadUrl("https://$HOST/src/renderer/index.html")
    }
    @Deprecated("API 33+ uses OnBackInvokedDispatcher; older devices use this callback")
    override fun onBackPressed() { handleBack() }
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        if (event.action == android.view.KeyEvent.ACTION_DOWN && event.keyCode != android.view.KeyEvent.KEYCODE_BACK) lastRootBackAt = 0L
        return super.dispatchKeyEvent(event)
    }
    private fun handleBack() {
        if (backPending || isFinishing || isDestroyed) return
        backPending = true
        // The shared UI consumes overlays, selection and dirty-form confirmation first.
        web.evaluateJavascript("window.__acornNativeBackState ? window.__acornNativeBackState() : ({consumed: false, interaction: -1})") { result ->
            backPending = false
            if (isFinishing || isDestroyed) return@evaluateJavascript
            val state = try { JSONObject(result) } catch (_: Exception) { JSONObject() }
            if (state.optBoolean("consumed")) { lastRootBackAt = 0L; return@evaluateJavascript }
            val interaction = state.optLong("interaction", -1)
            val now = android.os.SystemClock.elapsedRealtime()
            if (lastRootBackAt != 0L && now - lastRootBackAt <= 2000L && interaction == lastRootBackInteraction) {
                lastRootBackAt = 0L
                moveTaskToBack(true)
            } else {
                lastRootBackAt = now
                lastRootBackInteraction = interaction
                Toast.makeText(this, "再按一次返回桌面", Toast.LENGTH_SHORT).show()
            }
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (intent.getBooleanExtra("openTerm", false)) web.evaluateJavascript("document.querySelector('[data-tab=term]')?.click()", null)
    }
    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    private fun state(): JSONObject = JSONObject().put("data", CacheStore.read(this) ?: JSONObject.NULL)
        .put("pinned", false).put("status", status("unsupported", unsupported))
        .put("capabilities", JSONObject().put("login", false).put("refresh", false).put("pin", false))
    private fun status(state: String, message: String) = JSONObject().put("state", state).put("message", message)
    private fun publish(data: JSONObject? = null, error: String? = null) {
        val payload = JSONObject().put("status", status("unsupported", error ?: unsupported))
        if (data != null) payload.put("data", data)
        web.evaluateJavascript("window.__acornNativeUpdate($payload)", null)
    }
    private fun jsValue(value: Any?): String = org.json.JSONArray().put(value ?: JSONObject.NULL).toString().let { it.substring(1, it.length - 1) }
    private fun reply(id: String, result: Any? = null, error: String? = null) {
        web.evaluateJavascript("window.__acornNativeReply(${JSONObject.quote(id)},${jsValue(result)},${jsValue(error)})", null)
    }
    inner class NativeBridge {
        @JavascriptInterface fun call(id: String, method: String, encoded: String) {
            runOnUiThread {
                try {
                    when (method) {
                        "getState" -> reply(id, state())
                        "refresh", "login" -> { publish(error = unsupported); Toast.makeText(this@MainActivity, unsupported, Toast.LENGTH_LONG).show(); reply(id, JSONObject().put("supported", false).put("message", unsupported)) }
                        "hide" -> { moveTaskToBack(true); reply(id) }
                        "togglePin" -> { requestWidget(); reply(id, false) }
                        "openMenu" -> { menu(); reply(id) }
                        "saveData" -> { val data = CacheStore.save(this@MainActivity, encoded); TimetableWidgetProvider.updateAll(this@MainActivity); publish(data); reply(id, data) }
                        "clearData" -> {
                            // Called only by the shared renderer's explicit destructive-action confirmation.
                            CacheStore.clear(this@MainActivity)
                            TimetableWidgetProvider.updateAll(this@MainActivity)
                            val cleared = state()
                            web.evaluateJavascript("window.__acornNativeUpdate($cleared)", null)
                            reply(id, cleared)
                        }
                        "importData" -> chooseImport(id)
                        "exportCalendar" -> chooseExport(id, JSONObject(encoded))
                        "openExternal" -> { val url = org.json.JSONTokener(encoded).nextValue() as? String ?: error("链接无效"); val uri = Uri.parse(url); require(uri.scheme == "https" && uri.host in listOf("www.google.com", "uri.amap.com") && uri.userInfo == null) { "只支持 Google / 高德地图的 HTTPS 链接" }; startActivity(Intent(Intent.ACTION_VIEW, uri)); reply(id, true) }
                        "addCalendarEvent" -> { calendar(JSONObject(encoded)); reply(id, JSONObject().put("opened", true).put("saved", false)) }
                        else -> reply(id, error = "不支持的操作")
                    }
                } catch (error: Exception) { reply(id, error = error.message ?: "操作失败") }
            }
        }
    }
    private fun menu() {
        AlertDialog.Builder(this).setTitle("bcorn · 本地模式")
            .setItems(arrayOf("导入课表 JSON", "添加桌面小组件", "登录 / 刷新说明", "隐私说明")) { _, index ->
                when (index) {
                    0 -> chooseImport(null)
                    1 -> requestWidget()
                    2 -> AlertDialog.Builder(this).setMessage(unsupported).setPositiveButton("知道了", null).show()
                    3 -> AlertDialog.Builder(this).setMessage("课表与成绩仅保存在此应用的私有目录，不参与系统备份或设备迁移。无网络权限、后台任务或自动刷新。导出和添加日历由你在系统界面选择目标并确认。长按桌面小组件由启动器处理；点按进入应用查看课程。安装包不含个人课表。").setPositiveButton("知道了", null).show()
                }
            }.show()
    }
    private fun requestWidget() {
        val manager = getSystemService(AppWidgetManager::class.java)
        if (manager.isRequestPinAppWidgetSupported) manager.requestPinAppWidget(ComponentName(this, TimetableWidgetProvider::class.java), null, null)
        else Toast.makeText(this, "请长按桌面，选择小组件 → ACORN", Toast.LENGTH_LONG).show()
    }
    private fun chooseImport(id: String?) {
        if (documentRequest != null || exportContent != null) { id?.let { reply(it, error = "请先完成当前文件选择") }; return }
        documentRequest = id ?: MENU_REQUEST
        try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream")), IMPORT) }
        catch (error: Exception) { documentRequest = null; id?.let { reply(it, error = "没有可用的文件选择器") } }
    }
    private fun chooseExport(id: String, payload: JSONObject) {
        check(documentRequest == null && exportContent == null) { "请先完成当前文件选择" }
        val content = payload.getString("content")
        require(content.toByteArray().size <= CacheStore.MAX_BYTES) { "导出文件超过 2 MB" }
        val isCalendar = content.startsWith("BEGIN:VCALENDAR")
        if (!isCalendar) JSONObject(content) // JSON exports are also offered by the shared renderer.
        val name = payload.optString("filename", "acorn-timetable.ics").substringAfterLast('/').substringAfterLast('\\').take(100)
        documentRequest = id; exportContent = content
        try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(if (isCalendar) "text/calendar" else "application/json").putExtra(Intent.EXTRA_TITLE, name), EXPORT) }
        catch (error: Exception) { documentRequest = null; exportContent = null; throw error }
    }
    @Deprecated("Platform activity result API is sufficient for this dependency-free host")
    override fun onActivityResult(requestCode: Int, resultCode: Int, result: Intent?) {
        super.onActivityResult(requestCode, resultCode, result)
        if (requestCode == HTML_IMPORT) {
            val callback = fileCallback; fileCallback = null
            callback?.onReceiveValue(if (resultCode == RESULT_OK && result?.data != null) arrayOf(result.data!!) else null)
            return
        }
        if (requestCode != IMPORT && requestCode != EXPORT) return
        val id = documentRequest; documentRequest = null
        val content = exportContent; exportContent = null
        val uri = result?.data
        if (resultCode != RESULT_OK || uri == null) { if (id != null && id != MENU_REQUEST) reply(id, JSONObject().put("canceled", true)); return }
        try {
            if (requestCode == IMPORT) {
                val bytes = contentResolver.openInputStream(uri)?.use { input ->
                    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= CacheStore.MAX_BYTES) { "JSON 文件超过 2 MB" }; output.write(buffer, 0, count) }; output.toByteArray()
                } ?: error("无法打开文件")
                val raw = bytes.toString(Charsets.UTF_8).removePrefix("\uFEFF")
                // The shared renderer validates, previews, and asks before replacing local data.
                web.evaluateJavascript("readImport(new File([${JSONObject.quote(raw)}], 'import.json', {type:'application/json'}))", null)
                if (id != null && id != MENU_REQUEST) reply(id, JSONObject().put("preview", true))
            } else {
                require(content != null) { "导出已中断，请重试" }
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(content.toByteArray(Charsets.UTF_8)) } ?: error("无法写入文件")
                id?.let { reply(it, JSONObject().put("saved", true)) }
            }
        } catch (error: Exception) {
            val message = error.message ?: "文件操作失败"
            if (id != null && id != MENU_REQUEST) reply(id, error = message)
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        }
    }
    private fun calendar(event: JSONObject) {
        val start = event.getLong("startMillis"); val end = event.getLong("endMillis")
        require(end > start) { "日历起止时间无效" }
        val intent = Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.Events.TITLE, event.getString("title"))
            .putExtra(CalendarContract.Events.EVENT_LOCATION, event.optString("location"))
            .putExtra(CalendarContract.Events.DESCRIPTION, event.optString("description"))
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
        startActivity(intent) // User reviews and saves; never claims the event was saved.
    }
    override fun onPause() { lastRootBackAt = 0L; web.onPause(); web.pauseTimers(); super.onPause() }
    override fun onResume() { super.onResume(); web.onResume(); web.resumeTimers(); TimetableWidgetProvider.updateAll(this) }
    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= 33) backCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        backCallback = null
        fileCallback?.onReceiveValue(null); fileCallback = null; web.removeJavascriptInterface("AcornNative"); web.destroy(); super.onDestroy() }
    companion object { const val HOST = "appassets.androidplatform.net"; const val HTML_IMPORT = 30; const val IMPORT = 31; const val EXPORT = 32; const val MENU_REQUEST = "menu" }
}
