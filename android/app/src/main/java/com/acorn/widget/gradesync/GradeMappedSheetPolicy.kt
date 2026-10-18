package com.acorn.widget.gradesync

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal

/**
 * Immutable authority for one explicitly confirmed, human-authored sheet mapping. The native
 * spreadsheet ID is supplied by the Picker binding, never by the renderer's mapping or write list.
 *
 * This is an optimistic preflight, NOT compare-and-swap: Sheets values:batchUpdate has no atomic
 * precondition for cell values/formulas. A collaborator can change a formula after the fresh read
 * and before the write. The caller must disclose that limitation and verify the result afterward.
 */
class GradeMappedSheetPolicy private constructor(
    private val nativeSpreadsheetId: String,
    val sheetId: Int,
    val tab: String,
    private val serializedMapping: String,
    private val targets: Map<String, Target>,
    private val anchors: Map<String, String>
) {
    private data class Target(val mode: String, val grade: Boolean)
    private data class Cell(val value: Any, val formula: Boolean, val protected: Boolean, val merged: Boolean)

    /** Returns a defensive copy; mutating it cannot expand the confirmed native authority. */
    fun mappingJson(): JSONObject = JSONObject(serializedMapping)

    /**
     * Both snapshots are validated independently. Only confirmed targets and anchors participate
     * in conflict detection, so unrelated notes and calculated totals remain untouched.
     */
    fun prepareWrites(current: JSONObject, expected: JSONObject, writes: JSONArray): SheetRequest {
        val fresh = validateSnapshot(current)
        val prior = validateSnapshot(expected)
        for (address in targets.keys + anchors.keys) {
            val now = fresh.getValue(address)
            val before = prior.getValue(address)
            require(sameValue(now.value, before.value) && now.formula == before.formula &&
                now.protected == before.protected && now.merged == before.merged) { "conflict" }
        }
        val selected = validatedWrites(writes)
        val data = JSONArray()
        for (address in selected.keys.sortedBy(::cellOrder)) {
            data.put(JSONObject().put("range", "${GradeSheetsPolicy.a1(tab)}!$address")
                .put("majorDimension", "ROWS")
                .put("values", JSONArray().put(JSONArray().put(selected.getValue(address)))))
        }
        return SheetRequest("POST", "/v4/spreadsheets/$nativeSpreadsheetId/values:batchUpdate",
            JSONObject().put("valueInputOption", "RAW").put("data", data))
    }

    /** A successful HTTP response is insufficient; the native caller must fetch a new snapshot. */
    fun verifyWritten(snapshot: JSONObject, writes: JSONArray) {
        val observed = validateSnapshot(snapshot)
        for ((address, desired) in validatedWrites(writes)) {
            require(sameValue(observed.getValue(address).value, desired)) { "conflict" }
        }
    }

    private fun validatedWrites(writes: JSONArray): Map<String, Any> {
        require(writes.length() in 1..MAX_WRITES) { "limit-exceeded" }
        require(writes.toString().toByteArray(Charsets.UTF_8).size <= MAX_WRITE_BYTES) { "limit-exceeded" }
        val selected = linkedMapOf<String, Any>()
        for (index in 0 until writes.length()) {
            val write = writes.opt(index) as? JSONObject ?: invalid("invalid-request")
            exactKeys(write, setOf("cell", "value"), "invalid-request")
            val address = coordinate(text(write, "cell", 4, false, "invalid-request"), "invalid-request")
            val target = targets[address] ?: invalid("invalid-request")
            require(!selected.containsKey(address)) { "invalid-request" }
            selected[address] = validatedValue(write.opt("value"), target, "invalid-request")
        }
        return selected
    }

    private fun validateSnapshot(snapshot: JSONObject): Map<String, Cell> {
        require(snapshot.toString().toByteArray(Charsets.UTF_8).size <= GradeSheetsPolicy.MAX_BYTES) { "limit-exceeded" }
        exactKeys(snapshot, setOf("sheetId", "tab", "complete", "cells"), "mapping-changed")
        require(integer(snapshot.opt("sheetId"), "mapping-changed") == sheetId &&
            snapshot.opt("tab") is String && snapshot.opt("tab") == tab &&
            snapshot.opt("complete") == true) { "mapping-changed" }
        val cells = snapshot.opt("cells") as? JSONObject ?: invalid("mapping-changed")
        require(cells.length() <= MAX_CELLS) { "limit-exceeded" }
        val result = HashMap<String, Cell>(cells.length())
        for (address in cells.keys()) {
            coordinate(address, "mapping-changed")
            val cell = cells.opt(address) as? JSONObject ?: invalid("mapping-changed")
            allowedKeys(cell, setOf("value", "formula", "protected", "merged"), "mapping-changed")
            require(cell.has("value")) { "mapping-changed" }
            val value = cell.opt("value")
            require((value is String && value.length <= MAX_CELL_TEXT && value.none { it == '\u0000' }) ||
                value is Boolean || (value is Number && value.toDouble().isFinite())) { "mapping-changed" }
            result[address] = Cell(value!!, flag(cell, "formula"), flag(cell, "protected"), flag(cell, "merged"))
        }
        for ((address, label) in anchors) {
            val cell = result[address] ?: invalid("mapping-changed")
            require(cell.value is String && cell.value == label && !cell.formula && !cell.merged) { "mapping-changed" }
        }
        for ((address, target) in targets) {
            val cell = result[address] ?: invalid("mapping-changed")
            require(!cell.formula && !cell.protected && !cell.merged) { "mapping-changed" }
            validatedValue(cell.value, target, "mapping-changed")
        }
        return result
    }

    companion object {
        const val MAX_COURSES = 100
        const val MAX_ASSESSMENTS = 500
        const val MAX_WRITES = MAX_ASSESSMENTS * 2
        const val MAX_CELLS = 26 * 200
        const val MAX_MAPPING_BYTES = 256 * 1024
        const val MAX_WRITE_BYTES = 128 * 1024
        const val MAX_CELL_TEXT = 50000
        private val ADDRESS = Regex("[A-Z](?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)")
        private val FRACTION = Regex("(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)/(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)")

        @JvmStatic
        fun confirm(nativeSpreadsheetId: String, mapping: JSONObject, snapshot: JSONObject): GradeMappedSheetPolicy {
            require(nativeSpreadsheetId.matches(Regex("[A-Za-z0-9_-]{1,200}"))) { "invalid-mapping" }
            val serialized = mapping.toString()
            require(serialized.toByteArray(Charsets.UTF_8).size <= MAX_MAPPING_BYTES) { "limit-exceeded" }
            exactKeys(mapping, setOf("schemaVersion", "confirmed", "sheetId", "tab", "courses"), "invalid-mapping")
            require(integer(mapping.opt("schemaVersion"), "invalid-mapping") == 1 && mapping.opt("confirmed") == true) { "invalid-mapping" }
            val sheetId = integer(mapping.opt("sheetId"), "invalid-mapping")
            val tab = text(mapping, "tab", 100, false, "invalid-mapping")
            try { GradeSheetsPolicy.validateTab(tab) } catch (_: IllegalArgumentException) { invalid("invalid-mapping") }
            val courses = mapping.opt("courses") as? JSONArray ?: invalid("invalid-mapping")
            require(courses.length() in 1..MAX_COURSES) { "limit-exceeded" }
            val courseIds = HashSet<String>()
            val targets = linkedMapOf<String, Target>()
            val anchors = linkedMapOf<String, String>()
            var totalAssessments = 0
            for (courseIndex in 0 until courses.length()) {
                val course = courses.opt(courseIndex) as? JSONObject ?: invalid("invalid-mapping")
                exactKeys(course, setOf("id", "title", "termId", "rules", "assessments"), "invalid-mapping")
                require(courseIds.add(text(course, "id", 200, false, "invalid-mapping"))) { "invalid-mapping" }
                text(course, "title", 1000, false, "invalid-mapping")
                text(course, "termId", 1000, true, "invalid-mapping")
                val rules = course.opt("rules") as? JSONObject ?: invalid("invalid-mapping")
                exactKeys(rules, setOf("kind"), "invalid-mapping")
                require(rules.opt("kind") in setOf("weighted", "unconfirmed")) { "invalid-mapping" }
                val assessments = course.opt("assessments") as? JSONArray ?: invalid("invalid-mapping")
                require(assessments.length() in 1..MAX_ASSESSMENTS) { "limit-exceeded" }
                totalAssessments += assessments.length()
                require(totalAssessments <= MAX_ASSESSMENTS) { "limit-exceeded" }
                val assessmentIds = HashSet<String>()
                for (assessmentIndex in 0 until assessments.length()) {
                    val assessment = assessments.opt(assessmentIndex) as? JSONObject ?: invalid("invalid-mapping")
                    exactKeys(assessment, setOf("id", "title", "gradeCell", "weightCell", "gradeMode", "weightMode", "anchor"), "invalid-mapping")
                    require(assessmentIds.add(text(assessment, "id", 200, false, "invalid-mapping"))) { "invalid-mapping" }
                    text(assessment, "title", 1000, false, "invalid-mapping")
                    val gradeMode = text(assessment, "gradeMode", 10, false, "invalid-mapping")
                    val weightMode = text(assessment, "weightMode", 10, false, "invalid-mapping")
                    require(gradeMode in setOf("ratio", "percentage", "fraction") && weightMode in setOf("ratio", "percentage")) { "invalid-mapping" }
                    for ((key, target) in listOf("gradeCell" to Target(gradeMode, true), "weightCell" to Target(weightMode, false))) {
                        val address = coordinate(text(assessment, key, 4, false, "invalid-mapping"), "invalid-mapping")
                        require(!targets.containsKey(address)) { "invalid-mapping" }
                        targets[address] = target
                    }
                    val anchor = assessment.opt("anchor") as? JSONObject ?: invalid("invalid-mapping")
                    exactKeys(anchor, setOf("cell", "text"), "invalid-mapping")
                    val address = coordinate(text(anchor, "cell", 4, false, "invalid-mapping"), "invalid-mapping")
                    require(!anchors.containsKey(address)) { "invalid-mapping" }
                    anchors[address] = text(anchor, "text", 1000, false, "invalid-mapping")
                }
            }
            require(anchors.keys.none { targets.containsKey(it) }) { "invalid-mapping" }
            val policy = GradeMappedSheetPolicy(nativeSpreadsheetId, sheetId, tab, serialized, targets.toMap(), anchors.toMap())
            policy.validateSnapshot(snapshot)
            return policy
        }

        private fun invalid(code: String): Nothing = throw IllegalArgumentException(code)
        private fun allowedKeys(value: JSONObject, allowed: Set<String>, code: String) {
            require(value.keys().asSequence().all { it in allowed }) { code }
        }
        private fun exactKeys(value: JSONObject, allowed: Set<String>, code: String) {
            allowedKeys(value, allowed, code)
            require(value.length() == allowed.size) { code }
        }
        private fun text(value: JSONObject, key: String, max: Int, empty: Boolean, code: String): String {
            val result = value.opt(key) as? String ?: invalid(code)
            require(result.length <= max && (empty || result.isNotBlank()) && result.none { it.isISOControl() }) { code }
            return result
        }
        private fun integer(value: Any?, code: String): Int {
            require(value is Number) { code }
            val number = value.toDouble()
            require(number.isFinite() && number in 0.0..Int.MAX_VALUE.toDouble() && number == number.toInt().toDouble()) { code }
            return number.toInt()
        }
        private fun flag(value: JSONObject, key: String): Boolean {
            if (!value.has(key)) return false
            return value.opt(key) as? Boolean ?: invalid("mapping-changed")
        }
        private fun coordinate(address: String, code: String): String {
            require(ADDRESS.matches(address)) { code }
            return address
        }
        private fun cellOrder(address: String): Int = (address.substring(1).toInt() - 1) * 26 + address[0].code - 'A'.code
        private fun sameValue(left: Any, right: Any): Boolean =
            if (left is Number && right is Number) left.toDouble() == right.toDouble() else left == right
        private fun validatedValue(value: Any?, target: Target, code: String): Any {
            if (target.grade && value is String && value.isEmpty()) return ""
            if (target.grade && value is String) {
                require(value.length <= 100 && FRACTION.matches(value)) { code }
                val parts = value.split('/')
                val earned = parts[0].toDoubleOrNull() ?: invalid(code)
                val possible = parts[1].toDoubleOrNull() ?: invalid(code)
                require(earned.isFinite() && possible.isFinite() && earned >= 0 && possible > 0 &&
                    BigDecimal(parts[0]) <= BigDecimal(parts[1])) { code }
                return value
            }
            require(value is Number) { code }
            val number = value.toDouble()
            require(number.isFinite() && number in 0.0..(if (target.mode == "percentage") 100.0 else 1.0)) { code }
            return number
        }
    }
}
