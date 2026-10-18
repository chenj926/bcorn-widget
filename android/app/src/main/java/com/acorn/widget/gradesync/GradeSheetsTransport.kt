package com.acorn.widget.gradesync

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

interface GradeSheetsTransport {
    fun execute(request: SheetRequest, token: String, active: () -> Boolean): SheetResponse
    fun cancel()
}

/** Fixed TLS origins; no redirects, cookies, cache, logging, credential interceptors or retries. */
class HttpsGradeSheetsTransport @JvmOverloads constructor(private val calls: Call.Factory = client()) : GradeSheetsTransport {
    @Volatile private var call: Call? = null
    override fun cancel() { call?.cancel() }
    override fun execute(request: SheetRequest, token: String, active: () -> Boolean): SheetResponse {
        require((request.host == "sheets.googleapis.com" && request.path.startsWith("/v4/spreadsheets")) ||
            (request.host == "www.googleapis.com" && request.method == "GET" && request.body == null && (request.path == GradeAccountIdentity.PATH || request.path.matches(Regex("/drive/v3/files/[A-Za-z0-9_-]{1,200}\\?fields=version,modifiedTime"))))) { "invalid-request" }
        require(!request.path.contains('#') && !request.path.contains('\r') && !request.path.contains('\n')) { "invalid-request" }
        check(active()) { "offline" }
        val body = request.body?.toString()?.toByteArray(Charsets.UTF_8)?.also { require(it.size <= GradeSheetsPolicy.MAX_BYTES) { "limit-exceeded" } }
            ?.toRequestBody("application/json; charset=utf-8".toMediaType())
        val native = Request.Builder().url("https://${request.host}${request.path}")
            .header("Authorization", "Bearer $token").header("Accept", "application/json").method(request.method, body).build()
        val running = calls.newCall(native)
        call = running
        try {
            // Registration precedes the last lifecycle check. Unlike URLConnection.disconnect,
            // Call.cancel is sticky even when pause lands immediately before execute/connect.
            if (!active()) { running.cancel(); error("offline") }
            running.execute().use { response ->
                check(active()) { "offline" }
                if (response.code !in 200..299) {
                    // Google uses HTTP 403 for quotas as well as file ACL failures. Inspect only a
                    // bounded error object, return no raw body, and never call that OAuth revocation.
                    val error = if (response.code == 403) try {
                        response.body?.byteStream()?.use { input ->
                            val bytes = ByteArrayOutputStream(); val buffer = ByteArray(4096)
                            while (true) {
                                check(active()) { "offline" }
                                val count = input.read(buffer); if (count < 0) break
                                if (bytes.size() + count > 65536) break
                                bytes.write(buffer, 0, count)
                            }
                            JSONObject(bytes.toString("UTF-8"))
                        }
                    } catch (_: Exception) { null } else null
                    check(active()) { "offline" }
                    return SheetResponse(GoogleGradeFailurePolicy.status(response.code, error), JSONObject(), retryAfter(response.header("Retry-After")))
                }
                val responseBody = response.body ?: error("invalid-response")
                require(responseBody.contentLength() <= GradeSheetsPolicy.MAX_BYTES) { "limit-exceeded" }
                val bytes = ByteArrayOutputStream()
                responseBody.byteStream().use { input ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        check(active()) { "offline" }
                        val count = input.read(buffer); if (count == -1) break
                        require(bytes.size() + count <= GradeSheetsPolicy.MAX_BYTES) { "limit-exceeded" }
                        bytes.write(buffer, 0, count)
                    }
                }
                check(active()) { "offline" }
                return SheetResponse(response.code, JSONObject(bytes.toString("UTF-8")))
            }
        } finally { if (call === running) call = null; running.cancel() }
    }
    private fun retryAfter(value: String?): Long = value?.toLongOrNull()?.let { it.coerceIn(1, 3600) * 1000 } ?: 60_000L
    companion object {
        fun client(): OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()
    }
}

/** Normalized adapter status: 429 retries a quota, 404 requires checking/relinking this file. */
object GoogleGradeFailurePolicy {
    private val quotaReasons = setOf("rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED")
    fun status(httpStatus: Int, body: JSONObject?): Int {
        if (httpStatus != 403) return httpStatus
        val error = body?.optJSONObject("error")
        val reasons = mutableListOf<String>()
        error?.optJSONArray("errors")?.let { errors ->
            for (i in 0 until minOf(errors.length(), 100)) errors.optJSONObject(i)?.optString("reason")?.let { reasons.add(it) }
        }
        error?.optJSONArray("details")?.let { details ->
            for (i in 0 until minOf(details.length(), 100)) {
                val detail = details.optJSONObject(i) ?: continue
                if (detail.optString("@type") == "type.googleapis.com/google.rpc.ErrorInfo") reasons.add(detail.optString("reason"))
            }
        }
        return if (reasons.any { it in quotaReasons } || error?.optString("status") == "RESOURCE_EXHAUSTED") 429 else 404
    }
}
