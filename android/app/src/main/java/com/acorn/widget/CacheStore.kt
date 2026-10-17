package com.acorn.widget

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.LocalDate

/** App-private, excluded from both backup and device transfer. Never logs student data. */
object CacheStore {
    const val MAX_BYTES = 2 * 1024 * 1024
    private fun JSONObject.string(key: String): String = if (isNull(key)) "" else optString(key)
    private fun file(context: Context) = AtomicFile(File(context.filesDir, "timetable.json"))
    @Synchronized fun read(context: Context): JSONObject? = try {
        val bytes = file(context).readFully()
        if (bytes.size > MAX_BYTES) null else validate(JSONObject(bytes.toString(Charsets.UTF_8)))
    } catch (_: Exception) { null }
    @Synchronized fun clear(context: Context) {
        file(context).delete()
        // AtomicFile may leave a recovery/new file on an I/O failure; do not report success then.
        require(listOf("timetable.json", "timetable.json.bak", "timetable.json.new").none { File(context.filesDir, it).exists() }) { "无法清除本地课表，请重试" }
    }
    @Synchronized fun save(context: Context, raw: String): JSONObject {
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "JSON 文件超过 2 MB" }
        val value = validate(JSONObject(raw))
        val target = file(context)
        val stream = target.startWrite()
        try { stream.write(value.toString().toByteArray(Charsets.UTF_8)); target.finishWrite(stream) }
        catch (error: Exception) { target.failWrite(stream); throw error }
        return value
    }
    private fun validate(data: JSONObject): JSONObject {
        val terms = data.optJSONArray("terms") ?: error("JSON 必须包含 terms 数组")
        require(terms.length() <= 100) { "学期数量超过限制" }
        for (i in 0 until terms.length()) {
            val term = terms.getJSONObject(i)
            require(term.string("id").isNotBlank()) { "学期缺少 id" }
            date(term.string("start")); date(term.string("end"))
            val courses = term.optJSONArray("courses") ?: error("学期缺少 courses 数组")
            val meetings = term.optJSONArray("meetings") ?: error("学期缺少 meetings 数组")
            require(courses.length() <= 1000 && meetings.length() <= 3000) { "课程数量超过限制" }
            for (j in 0 until courses.length()) {
                val course = courses.getJSONObject(j)
                require(course.string("code").isNotBlank()) { "课程缺少 code" }
                require(course.string("type") in listOf("", "course", "event")) { "课程类型无效" }
            }
            for (j in 0 until meetings.length()) {
                val meeting = meetings.getJSONObject(j)
                require(meeting.string("code").isNotBlank()) { "课时缺少 code" }
                require(meeting.string("recurrence") in listOf("", "weekly", "once")) { "重复类型无效" }
                if (meeting.string("recurrence") == "once") {
                    val day = LocalDate.parse(meeting.getString("date"))
                    require(term.string("start").isBlank() || day.toString() >= term.string("start")) { "单次事项日期早于日历范围" }
                    require(term.string("end").isBlank() || day.toString() <= term.string("end")) { "单次事项日期晚于日历范围" }
                    meeting.put("from", day.toString()).put("until", day.toString()).put("day", day.dayOfWeek.value)
                } else date(meeting.string("date"))
                val start = meeting.string("start"); val end = meeting.string("end")
                // Time-to-be-announced records remain valid; timed records are strictly checked.
                if (start.isNotBlank() || end.isNotBlank()) {
                    require(time(start) != null && time(end) != null && time(end)!! > time(start)!!) { "课时起止时间无效" }
                    require(meeting.optInt("day") in 1..7) { "星期必须为 1–7" }
                }
                date(meeting.string("from")); date(meeting.string("until"))
                meeting.optJSONArray("exdates")?.let { dates -> for (k in 0 until dates.length()) date(dates.getString(k)) }
            }
        }
        data.optJSONObject("transcript")?.optJSONArray("sessions")?.let { sessions ->
            for (i in 0 until sessions.length()) require(sessions.getJSONObject(i).optJSONArray("courses") != null) { "成绩单学期缺少 courses 数组" }
        }
        return data
    }
    private fun date(value: String) { if (value.isNotBlank()) LocalDate.parse(value) }
    fun time(value: String): Int? {
        if (!Regex("^(?:[01]\\d|2[0-3]):[0-5]\\d$").matches(value)) return null
        return value.substring(0, 2).toInt() * 60 + value.substring(3).toInt()
    }
    fun objects(array: JSONArray?): List<JSONObject> = if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
}
