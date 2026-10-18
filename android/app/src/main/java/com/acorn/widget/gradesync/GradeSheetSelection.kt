package com.acorn.widget.gradesync

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A Picker result is an ephemeral read capability, never an active synchronization binding. */
class GradeSheetSelection(private val spreadsheetId: String, val accountKey: String) {
    val selectionId: String = UUID.randomUUID().toString()
    private var tabs = emptyMap<Int, String>()
    init { require(accountKey.matches(Regex("[a-f0-9]{64}"))); require(spreadsheetId.matches(Regex("[A-Za-z0-9_-]{1,200}"))) { "invalid-selection" } }
    fun metadataRequest() = SheetRequest("GET", "/v4/spreadsheets/$spreadsheetId?fields=" + GradeSheetsPolicy.encode("properties(title),sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)))"), null)
    fun acceptMetadata(body: JSONObject): JSONObject {
        val title = body.getJSONObject("properties").getString("title")
        require(title.length <= 1000 && title.none { it.isISOControl() }) { "invalid-response" }
        val sheets = body.getJSONArray("sheets")
        require(sheets.length() in 1..200) { "limit-exceeded" }
        val known = linkedMapOf<Int, String>(); val publicTabs = JSONArray()
        for (i in 0 until sheets.length()) {
            val properties = sheets.getJSONObject(i).getJSONObject("properties")
            if (properties.optString("sheetType", "GRID") != "GRID") continue
            val id = strictSheetId(properties.get("sheetId")); val tab = properties.getString("title")
            GradeSheetsPolicy.validateTab(tab)
            require(!known.containsKey(id)) { "invalid-response" }
            known[id] = tab
            publicTabs.put(JSONObject().put("sheetId", id).put("title", tab))
        }
        require(known.isNotEmpty()) { "invalid-selection" }
        tabs = known
        return JSONObject().put("selectionId", selectionId).put("title", title).put("tabs", publicTabs).put("readOnly", true)
    }
    fun tab(sheetId: Int): String = tabs[sheetId] ?: error("invalid-selection")
    fun previewRequest(sheetId: Int) = previewRequest(spreadsheetId, sheetId, tab(sheetId))
    fun binding(mapping: JSONObject) = GradeSheetBinding(spreadsheetId, tab(strictSheetId(mapping.get("sheetId"))), UUID.randomUUID().toString(), mapping, accountKey)
    fun policy(mapping: JSONObject, snapshot: JSONObject) = GradeMappedSheetPolicy.confirm(spreadsheetId, mapping, snapshot)
    companion object {
        const val ROWS = 200
        const val COLUMNS = 26
        fun strictSheetId(value: Any): Int {
            require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toInt().toDouble() && value.toInt() >= 0) { "invalid-selection" }
            return value.toInt()
        }
        fun previewRequest(fileId: String, sheetId: Int, tab: String): SheetRequest {
            require(fileId.matches(Regex("[A-Za-z0-9_-]{1,200}")) && sheetId >= 0) { "invalid-selection" }
            GradeSheetsPolicy.validateTab(tab)
            val range = GradeSheetsPolicy.encode("${GradeSheetsPolicy.a1(tab)}!A1:Z200")
            val fields = GradeSheetsPolicy.encode("sheets(properties(sheetId,title),merges,protectedRanges(range),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))")
            return SheetRequest("GET", "/v4/spreadsheets/$fileId?ranges=$range&includeGridData=true&fields=$fields", null)
        }
        /** Every cell in the fixed window is explicit, including blanks; no formulas or private file IDs leave native. */
        fun snapshot(body: JSONObject, sheetId: Int, tab: String): JSONObject {
            val sheets = body.getJSONArray("sheets")
            require(sheets.length() == 1) { "invalid-response" }
            val sheet = sheets.getJSONObject(0); val properties = sheet.getJSONObject("properties")
            require(strictSheetId(properties.get("sheetId")) == sheetId && properties.getString("title") == tab) { "mapping-changed" }
            val cells = JSONObject()
            for (row in 1..ROWS) for (column in 0 until COLUMNS) cells.put("${('A'.code + column).toChar()}$row", JSONObject().put("value", "").put("formula", false).put("protected", false).put("merged", false))
            val data = sheet.optJSONArray("data") ?: JSONArray()
            require(data.length() <= ROWS) { "limit-exceeded" }
            for (block in 0 until data.length()) {
                val grid = data.getJSONObject(block); val firstRow = grid.optInt("startRow", 0); val firstColumn = grid.optInt("startColumn", 0)
                require(firstRow in 0 until ROWS && firstColumn in 0 until COLUMNS) { "invalid-response" }
                val rows = grid.optJSONArray("rowData") ?: JSONArray()
                require(rows.length() <= ROWS - firstRow) { "limit-exceeded" }
                for (r in 0 until rows.length()) {
                    val values = rows.getJSONObject(r).optJSONArray("values") ?: JSONArray()
                    require(values.length() <= COLUMNS - firstColumn) { "limit-exceeded" }
                    for (c in 0 until values.length()) {
                        val original = values.getJSONObject(c); val entered = original.optJSONObject("userEnteredValue"); val effective = original.optJSONObject("effectiveValue")
                        val cell = cells.getJSONObject("${('A'.code + firstColumn + c).toChar()}${firstRow + r + 1}")
                        val value: Any = when {
                            effective?.has("numberValue") == true -> effective.getDouble("numberValue").also { require(it.isFinite()) { "invalid-response" } }
                            effective?.has("stringValue") == true -> effective.getString("stringValue").also { require(it.length <= 10000) { "limit-exceeded" } }
                            effective?.has("boolValue") == true -> effective.getBoolean("boolValue")
                            else -> ""
                        }
                        cell.put("value", value).put("formula", entered?.has("formulaValue") == true)
                        if (effective?.has("errorValue") == true) cell.put("protected", true)
                    }
                }
            }
            fun mark(range: JSONObject?, flag: String) {
                if (range?.has("sheetId") == true) require(strictSheetId(range.get("sheetId")) == sheetId) { "invalid-response" }
                val fromRow = range?.optInt("startRowIndex", 0) ?: 0; val toRow = range?.optInt("endRowIndex", ROWS) ?: ROWS
                val fromColumn = range?.optInt("startColumnIndex", 0) ?: 0; val toColumn = range?.optInt("endColumnIndex", COLUMNS) ?: COLUMNS
                require(fromRow >= 0 && fromColumn >= 0 && toRow >= fromRow && toColumn >= fromColumn) { "invalid-response" }
                for (r in fromRow.coerceAtMost(ROWS) until toRow.coerceAtMost(ROWS)) for (c in fromColumn.coerceAtMost(COLUMNS) until toColumn.coerceAtMost(COLUMNS)) cells.getJSONObject("${('A'.code + c).toChar()}${r + 1}").put(flag, true)
            }
            val merges = sheet.optJSONArray("merges") ?: JSONArray(); val protected = sheet.optJSONArray("protectedRanges") ?: JSONArray()
            require(merges.length() <= 10000 && protected.length() <= 10000) { "limit-exceeded" }
            for (i in 0 until merges.length()) mark(merges.getJSONObject(i), "merged")
            for (i in 0 until protected.length()) mark(protected.getJSONObject(i).optJSONObject("range"), "protected")
            return JSONObject().put("sheetId", sheetId).put("tab", tab).put("complete", true).put("cells", cells)
        }
    }
}
