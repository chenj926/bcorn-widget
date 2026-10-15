package io.bcorn.mobile

import android.content.Context
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime

/** The private native snapshot is the single source for Flutter and every widget. */
internal object TimetableStore {
    private const val PREFS = "bcorn_timetable"
    private const val KEY = "timetable_json"
    const val MAX_JSON_BYTES = 1_000_000

    fun load(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)

    fun save(context: Context, json: String) {
        require(json.toByteArray(Charsets.UTF_8).size <= MAX_JSON_BYTES) { "课表文件不能超过 1 MB" }
        parse(json) // Validate the entire replacement before changing the persisted snapshot.
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).commit()) {
            "无法保存课表，请检查设备存储空间"
        }
    }

    fun snapshot(context: Context): TimetableSnapshot {
        val json = load(context) ?: return TimetableSnapshot(emptyList(), hasSavedData = false)
        return try {
            TimetableSnapshot(parse(json), hasSavedData = true)
        } catch (_: Exception) {
            TimetableSnapshot(emptyList(), hasSavedData = true, invalid = true)
        }
    }

    internal fun parse(json: String): List<Course> {
        val root = JSONObject(json)
        require(integerValue(root, "version") == 1) { "不支持的课表格式版本" }
        val list = root.getJSONArray("courses")
        require(list.length() <= 500) { "最多支持 500 节课程" }
        val ids = HashSet<String>()
        return (0 until list.length()).map { index ->
            val item = list.getJSONObject(index)
            val id = stringValue(item, "id")
            val title = stringValue(item, "title").trim()
            val day = integerValue(item, "weekday")
            val start = integerValue(item, "startMinutes")
            val end = integerValue(item, "endMinutes")
            require(id.trim().isNotEmpty() && id.length <= 128 && ids.add(id)) { "课程编号为空或重复" }
            require(title.isNotEmpty() && title.length <= 120) { "课程名称为空或过长" }
            require(day in 1..7 && start in 0..1439 && end in 1..1440 && end > start) {
                "课程星期或时间无效；不支持跨午夜课程"
            }
            val startDate = dateValue(item, "startDate")
            val endDate = dateValue(item, "endDate")
            require(startDate == null || endDate == null || !endDate.isBefore(startDate)) { "课程日期范围无效" }
            val location = stringValue(item, "location")
            val mapUrl = stringValue(item, "mapUrl").trim()
            val notes = stringValue(item, "notes")
            require(location.length <= 500 && notes.length <= 4000 && mapUrl.length <= 4000) { "课程文字过长" }
            require(mapUrl.isBlank() || SafeLinks.validatedUri(mapUrl) != null) { "请使用有效的网页或地图链接" }
            val rawColor = if (!item.has("color") || item.isNull("color")) 0xFF487A70L else {
                val value = item.get("color")
                require(value is Int || value is Long) { "颜色必须为整数" }
                (value as Number).toLong()
            }
            require(rawColor in 0..0xFFFFFFFFL) { "颜色无效" }
            val color = rawColor.toInt()
            Course(id, title, day, start, end, location, mapUrl, notes, color, startDate, endDate)
        }
    }

    private fun stringValue(item: JSONObject, key: String): String {
        if (!item.has(key) || item.isNull(key)) return ""
        val value = item.get(key)
        require(value is String) { "$key 必须是文字" }
        return value
    }

    private fun integerValue(item: JSONObject, key: String): Int {
        val value = item.get(key)
        require(value is Int || value is Long) { "$key 必须是整数" }
        val number = (value as Number).toLong()
        require(number in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) { "$key 超出范围" }
        return number.toInt()
    }

    private fun dateValue(item: JSONObject, key: String): LocalDate? {
        if (!item.has(key) || item.isNull(key)) return null
        val raw = stringValue(item, key)
        if (raw.isEmpty()) return null
        require(Regex("\\d{4}-\\d{2}-\\d{2}").matches(raw)) { "日期必须使用 YYYY-MM-DD" }
        return LocalDate.parse(raw)
    }
}

internal data class Course(
    val id: String,
    val title: String,
    val weekday: Int,
    val startMinutes: Int,
    val endMinutes: Int,
    val location: String,
    val mapUrl: String,
    val notes: String,
    val color: Int,
    val startDate: LocalDate?,
    val endDate: LocalDate?,
) {
    fun occursOn(date: LocalDate): Boolean =
        weekday == date.dayOfWeek.value &&
            (startDate == null || !date.isBefore(startDate)) &&
            (endDate == null || !date.isAfter(endDate))

    fun isCurrent(minutes: Int): Boolean = startMinutes <= minutes && minutes < endMinutes
    val timeRange: String get() = "${formatMinutes(startMinutes)}–${formatMinutes(endMinutes)}"
}

internal data class TimetableSnapshot(
    val courses: List<Course>,
    val hasSavedData: Boolean,
    val invalid: Boolean = false,
) {
    fun today(now: LocalDateTime): List<Course> = courses.filter { it.occursOn(now.toLocalDate()) }
        .sortedWith(compareBy<Course> { it.startMinutes }.thenBy { it.title })
}

internal fun formatMinutes(minutes: Int): String =
    String.format(java.util.Locale.ROOT, "%02d:%02d", minutes / 60, minutes % 60)
