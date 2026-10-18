package com.acorn.widget

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Separate local-only grade data. Only whitelisted domain fields cross this disk boundary. */
object GradeBookStore {
    private fun file(context: Context) = AtomicFile(File(context.filesDir, "grades-v1.json"))
    @Synchronized fun read(context: Context): JSONObject? {
        val target = file(context)
        if (!target.baseFile.exists() && !File(target.baseFile.absolutePath + ".bak").exists()) return null
        val bytes = target.readFully()
        require(bytes.size <= CacheStore.MAX_BYTES) { "成绩文件超过 2 MB" }
        return validate(JSONObject(bytes.toString(Charsets.UTF_8)))
    }
    @Synchronized fun save(context: Context, raw: String) {
        require(raw.toByteArray(Charsets.UTF_8).size <= CacheStore.MAX_BYTES) { "成绩文件超过 2 MB" }
        val value = validate(JSONObject(raw))
        val target = file(context)
        val stream = target.startWrite()
        try { stream.write(value.toString().toByteArray(Charsets.UTF_8)); target.finishWrite(stream) }
        catch (error: Exception) { target.failWrite(stream); throw error }
    }
    private fun keys(value: JSONObject, allowed: Set<String>) {
        require(value.keys().asSequence().all { it in allowed }) { "成绩文件包含不支持的字段" }
    }
    private fun string(value: JSONObject, key: String, max: Int, required: Boolean = false): String {
        val raw = value.opt(key)
        require(raw is String && raw.length <= max && (key != "id" || raw.none { it.isISOControl() }) && (!required || raw.isNotBlank())) { "成绩字段 $key 无效" }
        return raw
    }
    private fun number(value: JSONObject, key: String, min: Double, max: Double): Double {
        val raw = value.opt(key)
        require(raw is Number) { "成绩数值 $key 无效" }
        val result = raw.toDouble()
        require(result.isFinite() && result in min..max) { "成绩数值 $key 超过范围" }
        return result
    }
    private fun validate(book: JSONObject): JSONObject {
        keys(book, setOf("schemaVersion", "courses"))
        require(book.opt("schemaVersion") is Number && book.getDouble("schemaVersion") == 1.0) { "不支持的成绩文件版本" }
        val courses = book.getJSONArray("courses")
        require(courses.length() <= 500) { "成绩课程数量超过限制" }
        val ids = mutableSetOf<String>()
        for (i in 0 until courses.length()) {
            val course = courses.getJSONObject(i)
            keys(course, setOf("id", "title", "termId", "rules", "assessments"))
            require(ids.add(string(course, "id", 200, true))) { "成绩课程 id 重复" }
            string(course, "title", 1000); string(course, "termId", 1000)
            val rules = course.getJSONObject("rules"); keys(rules, setOf("kind"))
            require(rules.optString("kind") in setOf("weighted", "unconfirmed")) { "计分规则无效" }
            val assessments = course.getJSONArray("assessments")
            require(assessments.length() <= 1000) { "考核数量超过限制" }
            val assessmentIds = mutableSetOf<String>()
            for (j in 0 until assessments.length()) {
                val assessment = assessments.getJSONObject(j)
                keys(assessment, setOf("id", "title", "weight", "status", "score"))
                require(assessmentIds.add(string(assessment, "id", 200, true))) { "考核 id 重复" }
                string(assessment, "title", 1000, true); number(assessment, "weight", 0.0, 1.0)
                val status = assessment.optString("status")
                require(status in setOf("graded", "ungraded", "exempt")) { "考核状态无效" }
                if (status != "graded") require(assessment.isNull("score")) { "未评分项目不能包含分数" }
                else {
                    val score = assessment.getJSONObject("score")
                    when (score.optString("mode")) {
                        "ratio" -> { keys(score, setOf("mode", "value")); number(score, "value", 0.0, 1.0) }
                        "points" -> {
                            keys(score, setOf("mode", "earned", "possible"))
                            val possible = number(score, "possible", Double.MIN_VALUE, Double.MAX_VALUE)
                            number(score, "earned", 0.0, possible)
                        }
                        else -> error("分数格式无效")
                    }
                }
            }
        }
        return book
    }
}
