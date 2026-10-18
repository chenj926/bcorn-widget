package com.acorn.widget.gradesync

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal

/**
 * Native-only creator for a new, dedicated human-readable grade sheet. The input is a bounded
 * domain course, never caller-supplied spreadsheet rows, formulas, destinations or mappings.
 * Existing sheets and the compatibility fourteen-column sync table are not modified here.
 */
class GradeMappedTemplate private constructor(
    val title: String,
    private val serializedRequest: String,
    private val serializedCourseMapping: String,
    private val serializedInitialValues: String
) {
    val tab: String get() = TAB

    fun request(): JSONObject = JSONObject(serializedRequest)

    fun mapping(actualSheetId: Int): JSONObject {
        require(actualSheetId >= 0) { "invalid-mapping" }
        return JSONObject().put("schemaVersion", 1).put("confirmed", true).put("sheetId", actualSheetId)
            .put("tab", TAB).put("courses", JSONArray().put(JSONObject(serializedCourseMapping)))
    }

    /** Binding is allowed only after a new read matches every requested initial grade and weight. */
    fun verifyCreated(snapshot: JSONObject) {
        val actualSheetId = snapshot.opt("sheetId") as? Number ?: throw IllegalArgumentException("mapping-changed")
        val id = actualSheetId.toDouble()
        require(id.isFinite() && id in 0.0..Int.MAX_VALUE.toDouble() && id == id.toInt().toDouble()) { "mapping-changed" }
        // This inert identifier only constructs the pure policy; verification performs no requests.
        val policy = GradeMappedSheetPolicy.confirm("created-template-readback", mapping(id.toInt()), snapshot)
        policy.verifyWritten(snapshot, JSONArray(serializedInitialValues))
    }

    companion object {
        const val TAB = "Grades"
        const val REQUESTED_SHEET_ID = 0
        const val MAX_ASSESSMENTS = 190
        private const val MAX_COURSE_BYTES = 256 * 1024

        @JvmStatic
        fun build(course: JSONObject): GradeMappedTemplate {
            require(course.toString().toByteArray(Charsets.UTF_8).size <= MAX_COURSE_BYTES) { "limit-exceeded" }
            keys(course, setOf("id", "title", "termId", "rules", "assessments"))
            val id = text(course, "id", 200)
            val courseTitle = text(course, "title", 1000)
            val term = text(course, "termId", 1000, true)
            val rules = course.opt("rules") as? JSONObject ?: invalid()
            keys(rules, setOf("kind"))
            require(rules.opt("kind") in setOf("weighted", "unconfirmed")) { "invalid-request" }
            val assessments = course.opt("assessments") as? JSONArray ?: invalid()
            require(assessments.length() in 1..MAX_ASSESSMENTS) { "limit-exceeded" }
            val rows = JSONArray().put(row(listOf("Assessment", "Weight", "Grade", "Contribution").map {
                literal(it).put("userEnteredFormat", JSONObject().put("textFormat", JSONObject().put("bold", true))
                    .put("backgroundColor", JSONObject().put("red", 0.89).put("green", 0.94).put("blue", 0.91)))
            }))
            val mapped = JSONArray()
            val initialValues = JSONArray()
            val ids = HashSet<String>()
            for (index in 0 until assessments.length()) {
                val assessment = assessments.opt(index) as? JSONObject ?: invalid()
                keys(assessment, setOf("id", "title", "weight", "status", "score"))
                val assessmentId = text(assessment, "id", 200)
                require(ids.add(assessmentId)) { "invalid-request" }
                val label = text(assessment, "title", 1000)
                val weight = number(assessment, "weight", 0.0, 1.0)
                // No status column exists in this template. Never silently convert exemptions.
                val status = assessment.opt("status")
                require(status == "graded" || status == "ungraded") { "invalid-request" }
                val grade: Any = if (status == "ungraded") {
                    require(assessment.opt("score") === JSONObject.NULL) { "invalid-request" }
                    ""
                } else {
                    val score = assessment.opt("score") as? JSONObject ?: invalid()
                    when (score.opt("mode")) {
                        "ratio" -> {
                            keys(score, setOf("mode", "value"))
                            number(score, "value", 0.0, 1.0)
                        }
                        "points" -> {
                            keys(score, setOf("mode", "earned", "possible"))
                            val possible = number(score, "possible", Double.MIN_VALUE, Double.MAX_VALUE)
                            val earned = number(score, "earned", 0.0, possible)
                            val fraction = "${decimal(earned)}/${decimal(possible)}"
                            require(fraction.length <= 100) { "limit-exceeded" }
                            fraction
                        }
                        else -> invalid()
                    }
                }
                val rowNumber = index + 2
                val gradeCell = "C$rowNumber"
                // Formula text is fixed native code. A zero grade is graded; a blank is pending.
                // A malformed manually edited fraction remains an error rather than a false zero.
                val contribution = "=IF($gradeCell=\"\",\"\",B$rowNumber*IF(ISNUMBER($gradeCell),$gradeCell,VALUE(INDEX(SPLIT($gradeCell,\"/\"),1,1))/VALUE(INDEX(SPLIT($gradeCell,\"/\"),1,2))))"
                rows.put(row(listOf(literal(label), percent(literal(weight)), percent(literal(grade)), percent(formula(contribution)))))
                initialValues.put(JSONObject().put("cell", "B$rowNumber").put("value", weight))
                    .put(JSONObject().put("cell", gradeCell).put("value", grade))
                mapped.put(JSONObject().put("id", assessmentId).put("title", label)
                    .put("gradeCell", gradeCell).put("weightCell", "B$rowNumber")
                    .put("gradeMode", "ratio").put("weightMode", "ratio")
                    .put("anchor", JSONObject().put("cell", "A$rowNumber").put("text", label)))
            }
            val end = assessments.length() + 1
            val weights = "B2:B$end"
            val grades = "C2:C$end"
            val contributions = "D2:D$end"
            val gradedWeight = "SUMIF($grades,\"<>\",$weights)"
            rows.put(row(emptyList()))
            for ((label, expression) in listOf(
                "Total weight" to "=SUM($weights)",
                "Earned contribution" to "=SUM($contributions)",
                "Graded weight" to "=$gradedWeight",
                "Current average" to "=IF($gradedWeight=0,\"\",SUM($contributions)/$gradedWeight)"
            )) rows.put(row(listOf(literal(label), percent(formula(expression)))))

            val title = courseTitle.take(200)
            val request = JSONObject().put("properties", JSONObject().put("title", title))
                .put("sheets", JSONArray().put(JSONObject()
                    .put("properties", JSONObject().put("sheetId", REQUESTED_SHEET_ID).put("title", TAB)
                        .put("gridProperties", JSONObject().put("rowCount", 200).put("columnCount", 26).put("frozenRowCount", 1)))
                    .put("data", JSONArray().put(JSONObject().put("startRow", 0).put("startColumn", 0).put("rowData", rows)))))
            val courseMapping = JSONObject().put("id", id).put("title", courseTitle).put("termId", term)
                .put("rules", JSONObject().put("kind", rules.getString("kind"))).put("assessments", mapped)
            return GradeMappedTemplate(title, request.toString(), courseMapping.toString(), initialValues.toString())
        }

        private fun invalid(): Nothing = throw IllegalArgumentException("invalid-request")
        private fun keys(value: JSONObject, allowed: Set<String>) {
            require(value.length() == allowed.size && value.keys().asSequence().all { it in allowed }) { "invalid-request" }
        }
        private fun text(value: JSONObject, key: String, limit: Int, empty: Boolean = false): String {
            val result = value.opt(key) as? String ?: invalid()
            require(result.length <= limit && (empty || result.isNotBlank()) && result.none { it.isISOControl() }) { "invalid-request" }
            return result
        }
        private fun number(value: JSONObject, key: String, min: Double, max: Double): Double {
            val result = value.opt(key) as? Number ?: invalid()
            return result.toDouble().also { require(it.isFinite() && it in min..max) { "invalid-request" } }
        }
        private fun decimal(value: Double): String = BigDecimal.valueOf(value).stripTrailingZeros().toPlainString()
        private fun row(cells: List<JSONObject>): JSONObject = JSONObject().put("values", JSONArray(cells))
        private fun literal(value: Any): JSONObject = JSONObject().put("userEnteredValue", JSONObject().apply {
            if (value is Number) put("numberValue", value) else put("stringValue", value)
        })
        private fun formula(value: String): JSONObject = JSONObject().put("userEnteredValue", JSONObject().put("formulaValue", value))
        private fun percent(cell: JSONObject): JSONObject = cell.put("userEnteredFormat",
            JSONObject().put("numberFormat", JSONObject().put("type", "PERCENT").put("pattern", "0.00%")))
    }
}
