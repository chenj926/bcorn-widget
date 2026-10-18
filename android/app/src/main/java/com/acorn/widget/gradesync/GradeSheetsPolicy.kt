package com.acorn.widget.gradesync

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/** The renderer can edit one bounded grade table, never select an account, URL or other file. */
object GradeSheetsPolicy {
    const val MAX_BYTES = 4 * 1024 * 1024
    val HEADERS = listOf("recordId", "type", "courseId", "courseTitle", "term", "assessmentId", "assessment", "weight", "status", "scoreMode", "ratio", "earned", "possible", "rule")
    fun encode(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20").replace("%27", "'").replace("%21", "!").replace("%28", "(").replace("%29", ")").replace("%7E", "~")
    fun a1(tab: String) = "'${tab.replace("'", "''")}'"
    fun validateTab(tab: String) {
        require(tab.isNotBlank() && tab.length <= 100 && tab.none { it.isISOControl() || it in "[]:*?/\\" }) { "invalid-template" }
    }
    fun template(title: String, tab: String): JSONObject {
        require(title.isNotBlank() && title.length <= 200 && title.none { it.isISOControl() }) { "invalid-template" }
        validateTab(tab)
        return JSONObject().put("properties", JSONObject().put("title", title)).put("sheets", JSONArray().put(
            JSONObject().put("properties", JSONObject().put("title", tab).put("gridProperties", JSONObject().put("rowCount", 1002).put("columnCount", 14).put("frozenRowCount", 1)))
                .put("data", JSONArray().put(JSONObject().put("rowData", JSONArray().put(JSONObject().put("values", JSONArray(HEADERS.map {
                    JSONObject().put("userEnteredValue", JSONObject().put("stringValue", it))
                }))))))
        ))
    }
    fun keys(value: JSONObject, allowed: Set<String>) { require(value.keys().asSequence().all { it in allowed }) { "invalid-request" } }
    fun validate(binding: GradeSheetBinding, args: JSONObject): SheetRequest {
        require(binding.mapping == null) { "invalid-request" }
        keys(args, setOf("method", "path", "body"))
        val method = args.getString("method")
        val path = args.getString("path")
        val prefix = "/v4/spreadsheets/${binding.spreadsheetId}/values/"
        val table = a1(binding.tab)
        if (method == "GET") {
            require(path == prefix + encode("$table!A1:N1002") + "?valueRenderOption=UNFORMATTED_VALUE" && args.isNull("body")) { "invalid-request" }
            return SheetRequest(method, path, null)
        }
        require(method == "PUT") { "invalid-request" }
        val body = args.getJSONObject("body")
        require(body.toString().toByteArray(Charsets.UTF_8).size <= 64 * 1024) { "limit-exceeded" }
        keys(body, setOf("range", "majorDimension", "values"))
        require(body.getString("majorDimension") == "ROWS") { "invalid-request" }
        val range = body.getString("range")
        val suffix = range.removePrefix("$table!A")
        require(range.startsWith("$table!A")) { "invalid-request" }
        val parts = suffix.split(":N")
        val row = parts.firstOrNull()?.toIntOrNull()
        require(parts.size == 2 && row != null && row in 2..1001 && parts[0] == row.toString() && parts[1] == row.toString()) { "invalid-request" }
        require(path == prefix + encode(range) + "?valueInputOption=RAW") { "invalid-request" }
        val values = body.getJSONArray("values")
        require(values.length() == 1) { "invalid-request" }
        validateRow(values.getJSONArray(0))
        return SheetRequest(method, path, JSONObject(body.toString()))
    }
    private fun validateRow(row: JSONArray) {
        require(row.length() == 14) { "invalid-request" }
        for (i in 0..13) {
            val cell = row.get(i)
            require((cell is String && cell.length <= 2000 && cell.none { it == '\u0000' }) || (cell is Number && cell.toDouble().isFinite())) { "invalid-request" }
        }
        fun text(i: Int, required: Boolean = false) { require(row.get(i) is String && (!required || row.getString(i).isNotBlank())) { "invalid-request" } }
        fun empty(vararg columns: Int) { require(columns.all { row.get(it) == "" }) { "invalid-request" } }
        fun number(i: Int, low: Double, high: Double): Double {
            require(row.get(i) is Number) { "invalid-request" }
            return row.getDouble(i).also { require(it.isFinite() && it in low..high) { "invalid-request" } }
        }
        text(0, true); require(row.getString(0).length <= 1000) { "invalid-request" }
        when (row.getString(1)) {
            "deleted" -> empty(*((2..13).toList().toIntArray()))
            "course" -> { text(2, true); text(3); text(4); empty(5, 6, 7, 8, 9, 10, 11, 12); require(row.getString(13) in setOf("weighted", "unconfirmed")) { "invalid-request" } }
            "assessment" -> {
                text(2, true); text(5, true); text(6, true); empty(3, 4, 13); number(7, 0.0, 1.0)
                when (row.getString(8)) {
                    "ungraded", "exempt" -> empty(9, 10, 11, 12)
                    "graded" -> when (row.getString(9)) {
                        "ratio" -> { number(10, 0.0, 1.0); empty(11, 12) }
                        "points" -> { val possible = number(12, Double.MIN_VALUE, Double.MAX_VALUE); number(11, 0.0, possible); empty(10) }
                        else -> error("invalid-request")
                    }
                    else -> error("invalid-request")
                }
            }
            else -> error("invalid-request")
        }
    }
}

class GradeSheetBinding @JvmOverloads constructor(val spreadsheetId: String, val tab: String, val connectionId: String, mapping: JSONObject? = null, val accountKey: String? = null) {
    private val mappingText = mapping?.toString()
    val mapping: JSONObject? get() = mappingText?.let { JSONObject(it) }
    init { require(accountKey == null || accountKey.matches(Regex("[a-f0-9]{64}"))); require(spreadsheetId.matches(Regex("[A-Za-z0-9_-]{1,200}"))); GradeSheetsPolicy.validateTab(tab); require(connectionId.matches(Regex("[a-f0-9-]{36}"))) }
    fun publicJson(): JSONObject = JSONObject().put("tab", tab).put("confirmed", true).apply { if (mappingText == null) put("spreadsheetId", spreadsheetId) else put("kind", "mapped").put("mapping", mapping) }
    fun storedJson(): JSONObject = publicJson().put("spreadsheetId", spreadsheetId).put("connectionId", connectionId).apply { accountKey?.let { put("accountKey", it) } }
    companion object { fun parse(value: JSONObject) = GradeSheetBinding(value.getString("spreadsheetId"), value.getString("tab"), value.getString("connectionId"), value.optJSONObject("mapping"), value.optString("accountKey").takeIf { it.isNotBlank() }) }
}
class SheetRequest @JvmOverloads constructor(val method: String, val path: String, val body: JSONObject?, val host: String = "sheets.googleapis.com")
class SheetResponse(val status: Int, val body: JSONObject, val retryAfterMs: Long = 0) {
    fun json(): JSONObject = JSONObject().put("status", status).put("body", body).apply { if (retryAfterMs > 0) put("retryAfterMs", retryAfterMs) }
}
