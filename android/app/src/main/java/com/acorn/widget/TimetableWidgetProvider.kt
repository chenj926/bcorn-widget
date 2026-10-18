package com.acorn.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Bundle
import android.net.Uri
import android.widget.RemoteViews
import android.view.View
import org.json.JSONObject
import org.json.JSONArray
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.ZoneId
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** Launcher-owned RemoteViews survive app process death. System-batched local refresh; no service/network. */
class TimetableWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { ids.forEach { update(context, manager, it) } }
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) { update(context, manager, id) }
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(ACTION_PREVIOUS, ACTION_NEXT, ACTION_TODAY, ACTION_MODE)) {
            super.onReceive(context, intent); return
        }
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val manager = AppWidgetManager.getInstance(context)
        // Explicit immutable PendingIntents target this non-exported provider. Ignore stale/deleted IDs.
        if (id !in manager.getAppWidgetIds(ComponentName(context, TimetableWidgetProvider::class.java))) return
        try {
            if (intent.action == ACTION_TODAY) WidgetWeekStore.followToday(context, id)
            else if (intent.action == ACTION_MODE) WidgetWeekStore.toggleMode(context, id)
            else {
                val terms = CacheStore.objects(CacheStore.read(context)?.optJSONArray("terms"))
                val primary = selectPrimary(terms, null)
                val today = LocalDate.now(primary?.let { zone(it) } ?: ZoneId.of("America/Toronto"))
                WidgetWeekStore.navigate(context, id, if (intent.action == ACTION_PREVIOUS) -1 else 1, today)
            }
        } catch (_: Exception) { /* Keep the last durable selection on an I/O failure. */ }
        update(context, manager, id)
    }
    override fun onDeleted(context: Context, appWidgetIds: IntArray) { WidgetWeekStore.remove(context, appWidgetIds) }
    override fun onRestored(context: Context, oldWidgetIds: IntArray, newWidgetIds: IntArray) {
        WidgetWeekStore.restore(context, oldWidgetIds, newWidgetIds)
        onUpdate(context, AppWidgetManager.getInstance(context), newWidgetIds)
    }
    companion object {
        const val ACTION_PREVIOUS = "com.bcorn.widget.PREVIOUS_WEEK"
        const val ACTION_NEXT = "com.bcorn.widget.NEXT_WEEK"
        const val ACTION_TODAY = "com.bcorn.widget.TODAY_WEEK"
        const val ACTION_MODE = "com.bcorn.widget.TOGGLE_DAY_WEEK"
        private fun JSONObject.optionalString(key: String): String = if (isNull(key)) "" else optString(key)
        private fun waiting(value: JSONObject): Boolean = Regex("wait[\\s_-]*list|waiting|候补|候補", RegexOption.IGNORE_CASE).containsMatchIn(value.optString("status"))
        private val hues = floatArrayOf(212f, 152f, 28f, 338f, 262f, 188f, 96f, 8f)
        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            manager.getAppWidgetIds(ComponentName(context, TimetableWidgetProvider::class.java)).forEach { update(context, manager, it) }
        }
        private fun update(context: Context, manager: AppWidgetManager, id: Int) {
            val options = manager.getAppWidgetOptions(id)
            val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
            // The legacy options describe portrait MIN_WIDTH/MAX_HEIGHT and landscape MAX_WIDTH/MIN_HEIGHT.
            val widthKey = if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH
            val heightKey = if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT
            val width = options.getInt(widthKey, 350).takeIf { it > 0 }?.coerceIn(160, 600) ?: 350
            val height = options.getInt(heightKey, 490).takeIf { it > 0 }?.coerceIn(150, 800) ?: 490
            val views = try { createViews(context, id, width, height, CacheStore.read(context)) }
            catch (_: Exception) {
                // A malformed cache or OEM rendering failure must not strand an empty/loading widget.
                RemoteViews(context.packageName, R.layout.timetable_widget).apply {
                    setTextViewText(R.id.widget_title, "bcorn · 本地课表")
                    setTextViewText(R.id.widget_placeholder, "课表暂时无法显示\n点按打开应用重新导入或保存")
                    setViewVisibility(R.id.widget_placeholder, View.VISIBLE)
                    setViewVisibility(R.id.widget_grid, View.GONE)
                    setTextViewText(R.id.widget_hint, "本地数据保留 · 无后台联网")
                    setViewVisibility(R.id.widget_header, if (width < 204) View.GONE else View.VISIBLE)
                    setViewVisibility(R.id.widget_header_compact, if (width < 204) View.VISIBLE else View.GONE)
                    val state = WidgetWeekStore.state(context, id)
                    wireActions(this, context, id, state.date(LocalDate.now(ZoneId.of("America/Toronto"))), state.mode)
                }
            }
            manager.updateAppWidget(id, views)
        }
        private fun openApp(context: Context, id: Int, selectedDate: LocalDate? = null, mode: WidgetWeekStore.Mode = WidgetWeekStore.Mode.WEEK): PendingIntent = PendingIntent.getActivity(context, id,
            Intent(context, MainActivity::class.java).putExtra("openTerm", true).apply {
                selectedDate?.let { putExtra("weekStart", WidgetWeekStore.monday(it).toString()); putExtra("selectedDate", it.toString()) }
                putExtra("widgetMode", mode.value)
            }.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        private fun wireActions(views: RemoteViews, context: Context, id: Int, selectedDate: LocalDate? = null, mode: WidgetWeekStore.Mode = WidgetWeekStore.Mode.WEEK) {
            views.setOnClickPendingIntent(R.id.widget_root, openApp(context, id, selectedDate, mode))
            views.setOnClickPendingIntent(R.id.widget_content, openApp(context, id, selectedDate, mode))
            listOf(R.id.widget_previous to ACTION_PREVIOUS, R.id.widget_next to ACTION_NEXT, R.id.widget_today to ACTION_TODAY, R.id.widget_mode to ACTION_MODE,
                R.id.widget_previous_compact to ACTION_PREVIOUS, R.id.widget_next_compact to ACTION_NEXT, R.id.widget_today_compact to ACTION_TODAY, R.id.widget_mode_compact to ACTION_MODE).forEach { (view, action) ->
                val intent = Intent(context, TimetableWidgetProvider::class.java).setAction(action)
                    .setData(Uri.parse("bcorn-widget://${context.packageName}/week/$id/$action"))
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                views.setOnClickPendingIntent(view, PendingIntent.getBroadcast(context, id, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            }
        }
        private fun selectPrimary(terms: List<JSONObject>, anchor: LocalDate?): JSONObject? {
            fun todayFor(term: JSONObject) = (anchor ?: LocalDate.now(zone(term))).toString()
            val academic = terms.filter { !it.optString("id").startsWith("personal-") && CacheStore.objects(it.optJSONArray("courses")).any { c -> c.optString("type") != "event" } }
            val candidates = academic.ifEmpty { terms }
            return candidates.firstOrNull { it.optString("start") <= todayFor(it) && it.optString("end") >= todayFor(it) }
                ?: candidates.filter { it.optString("start") > todayFor(it) }.minByOrNull { it.optString("start") }
                ?: candidates.maxByOrNull { it.optString("end") }
        }
        /** Deterministic date override is the clock, not the selection; persisted browsing still wins. */
        fun createViews(context: Context, id: Int, width: Int, height: Int, data: JSONObject?, dateOverride: LocalDate? = null): RemoteViews {
            val terms = CacheStore.objects(data?.optJSONArray("terms"))
            val state = WidgetWeekStore.state(context, id)
            val primary = selectPrimary(terms, state.selectedDate ?: dateOverride)
            val today = dateOverride ?: LocalDate.now(primary?.let { zone(it) } ?: ZoneId.of("America/Toronto"))
            val selectedDate = state.date(today)
            val weekStart = WidgetWeekStore.monday(selectedDate)
            val dayMode = state.mode == WidgetWeekStore.Mode.DAY
            val displayZone = primary?.let { zone(it) } ?: ZoneId.of("America/Toronto")
            val term = primary?.let { weekModel(terms, it, weekStart, displayZone) }
            val compact = width < 260 || height < 260
            val allMeetings = CacheStore.objects(term?.optJSONArray("meetings"))
            val meetings = if (term == null) emptyList() else allMeetings.filter { m ->
                if (dayMode) occursOn(term, m, selectedDate) else (0L..6L).any { offset -> occursOn(term, m, weekStart.plusDays(offset)) }
            }
            val narrowHeader = width < 204
            val grid = GridRenderer(width - 12, max(1, height - if (narrowHeader) 108 else 60), compact, term, meetings, weekStart, context.resources.displayMetrics.density, if (dayMode) selectedDate else null).render()
            val views = RemoteViews(context.packageName, R.layout.timetable_widget)
            views.setTextViewText(R.id.widget_title, if (width < 220) "bcorn" else "bcorn · ${term?.optString("name") ?: "课表"}")
            val weekEnd = weekStart.plusDays(6)
            val dateLabel = if (dayMode) "${selectedDate.monthValue}/${selectedDate.dayOfMonth} 周${arrayOf("", "一", "二", "三", "四", "五", "六", "日")[selectedDate.dayOfWeek.value]}"
                else if (narrowHeader) "${weekStart.monthValue}/${weekStart.dayOfMonth}–${if (weekStart.monthValue == weekEnd.monthValue) "" else "${weekEnd.monthValue}/"}${weekEnd.dayOfMonth}" else "${weekStart.year} · ${weekStart.monthValue}/${weekStart.dayOfMonth}–${weekEnd.monthValue}/${weekEnd.dayOfMonth}"
            views.setViewVisibility(R.id.widget_header, if (narrowHeader) View.GONE else View.VISIBLE)
            views.setViewVisibility(R.id.widget_header_compact, if (narrowHeader) View.VISIBLE else View.GONE)
            views.setTextViewText(R.id.widget_week, dateLabel)
            views.setTextViewText(R.id.widget_date_compact, dateLabel)
            val period = if (dayMode) selectedDate.toString() else "${weekStart}至${weekEnd}"
            val currentDescription = "$period，${displayZone.id}。${if (dayMode) "日视图" else "周视图"}，回到今天"
            listOf(R.id.widget_today, R.id.widget_today_compact).forEach { views.setContentDescription(it, currentDescription) }
            listOf(R.id.widget_previous, R.id.widget_previous_compact).forEach { views.setContentDescription(it, if (dayMode) "前一天" else "上一周") }
            listOf(R.id.widget_next, R.id.widget_next_compact).forEach { views.setContentDescription(it, if (dayMode) "后一天" else "下一周") }
            listOf(R.id.widget_mode, R.id.widget_mode_compact).forEach {
                views.setTextViewText(it, if (dayMode) "切换周" else "切换日")
                views.setContentDescription(it, if (dayMode) "当前日视图，切换为周视图" else "当前周视图，切换为日视图")
            }
            views.setViewVisibility(R.id.widget_placeholder, View.GONE)
            views.setViewVisibility(R.id.widget_grid, View.VISIBLE)
            views.setImageViewBitmap(R.id.widget_grid, grid)
            val courses = CacheStore.objects(term?.optJSONArray("courses"))
            val waitCodes = courses.filter { waiting(it) }.map { it.optString("code") }.toSet() + allMeetings.filter { waiting(it) }.map { it.optString("code") }
            val tbaCount = courses.count { !it.optBoolean("widgetScheduled") }
            val summary = meetings.take(60).joinToString("；") { m ->
                "${courseCaption(m, courses, true)} ${if (m.optString("code") in waitCodes) "候补 " else ""}${if (m.optString("recurrence") == "once") m.optString("date") else "周${m.optInt("day")}"} ${m.optString("start")}至${m.optString("end")} ${m.optString("room").ifBlank { m.optString("location") }}" }
            views.setContentDescription(R.id.widget_grid, "$period，${if (dayMode) "日课表" else "周课表"}，${term?.optString("name") ?: "暂无数据"}。候补 ${waitCodes.size} 门，时间待定 $tbaCount 门。$summary。点按打开完整课表。")
            val counts = listOfNotNull(if (waitCodes.isNotEmpty()) "候补 ${waitCodes.size}" else null, if (tbaCount > 0) "待定 $tbaCount" else null).joinToString(" · ")
            views.setViewVisibility(R.id.widget_hint, View.GONE)
            views.setTextViewText(R.id.widget_hint, if (term == null) "点按添加课程或日程" else "${displayZone.id}${if (counts.isBlank()) "" else " · $counts"}")
            wireActions(views, context, id, selectedDate, state.mode)
            return views
        }
        private fun zone(term: JSONObject): ZoneId = try { ZoneId.of(term.optString("timezone", "America/Toronto")) } catch (_: Exception) { ZoneId.of("America/Toronto") }
        /** Keep the primary academic calendar and overlay personal events from every other calendar.
         * Convert actual dated occurrences, not weekday numbers, so timezone and DST remain correct.
         * Copies are render-only; imported cache IDs, times and dates are never rewritten here.
         */
        fun weekModel(terms: List<JSONObject>, primary: JSONObject, weekStart: LocalDate, displayZone: ZoneId): JSONObject {
            val result = JSONObject().put("name", primary.optString("name")).put("timezone", displayZone.id)
                .put("start", weekStart.toString()).put("end", weekStart.plusDays(6).toString())
            val courses = JSONArray(); val meetings = JSONArray()
            result.put("holidays", primary.optJSONArray("holidays") ?: JSONArray())
            val weekEnd = weekStart.plusDays(7)
            val formatter = DateTimeFormatter.ofPattern("HH:mm", java.util.Locale.ROOT)
            terms.forEachIndexed { index, source ->
                val sourceZone = zone(source)
                val firstSourceDay = weekStart.atStartOfDay(displayZone).withZoneSameInstant(sourceZone).toLocalDate()
                val lastSourceDay = weekEnd.atStartOfDay(displayZone).minusNanos(1).withZoneSameInstant(sourceZone).toLocalDate()
                val sourceMeetings = CacheStore.objects(source.optJSONArray("meetings"))
                val onceCodes = sourceMeetings.filter { it.optString("recurrence") == "once" && it.optString("date") >= firstSourceDay.toString() && it.optString("date") <= lastSourceDay.toString() }.map { it.optString("code") }.toSet()
                val sourceCourses = CacheStore.objects(source.optJSONArray("courses"))
                    .filter { source === primary || it.optString("type") == "event" || it.optString("code") in onceCodes }
                val codes = sourceCourses.map { it.optString("code") }.toSet()
                val scheduledCodes = sourceMeetings.filter { CacheStore.time(it.optString("start")) != null && CacheStore.time(it.optString("end")) != null }.map { it.optString("code") }.toSet()
                sourceCourses.forEach { course -> courses.put(JSONObject(course.toString())
                    .put("displayCode", course.optString("code")).put("code", "$index:${course.optString("code")}")
                    .put("widgetScheduled", course.optString("code") in scheduledCodes)) }
                sourceMeetings.filter { it.optString("code") in codes && (source === primary || it.optString("recurrence") == "once" || sourceCourses.any { c -> c.optString("code") == it.optString("code") && c.optString("type") == "event" }) }.forEach meetingLoop@ { meeting ->
                    val startMinutes = CacheStore.time(meeting.optString("start")) ?: return@meetingLoop
                    val endMinutes = CacheStore.time(meeting.optString("end")) ?: return@meetingLoop
                    var day = firstSourceDay
                    while (day <= lastSourceDay) {
                        if (occursOn(source, meeting, day)) {
                            val startLocal = day.atTime(LocalTime.of(startMinutes / 60, startMinutes % 60))
                            val endLocal = day.atTime(LocalTime.of(endMinutes / 60, endMinutes % 60))
                            // A nonexistent DST wall time is not silently shifted to a different appointment.
                            if (sourceZone.rules.getValidOffsets(startLocal).isNotEmpty() && sourceZone.rules.getValidOffsets(endLocal).isNotEmpty()) {
                                val start = startLocal.atZone(sourceZone).withZoneSameInstant(displayZone)
                                val end = endLocal.atZone(sourceZone).withZoneSameInstant(displayZone)
                                var partDay = start.toLocalDate()
                                while (partDay <= end.toLocalDate()) {
                                    val partStart = if (partDay == start.toLocalDate()) start else partDay.atStartOfDay(displayZone)
                                    val nextDay = partDay.plusDays(1).atStartOfDay(displayZone)
                                    val partEnd = if (end < nextDay) end else nextDay
                                    if (partEnd > partStart && partDay >= weekStart && partDay < weekEnd) {
                                        meetings.put(JSONObject(meeting.toString())
                                            .put("code", "$index:${meeting.optString("code")}").put("displayCode", meeting.optString("code"))
                                            .put("day", partDay.dayOfWeek.value).put("from", partDay.toString()).put("until", partDay.toString())
                                            .put("date", partDay.toString()).put("exdates", JSONArray())
                                            .put("start", partStart.format(formatter))
                                            .put("end", if (partEnd == nextDay) "24:00" else partEnd.format(formatter)))
                                    }
                                    partDay = partDay.plusDays(1)
                                }
                            }
                        }
                        day = day.plusDays(1)
                    }
                }
            }
            return result.put("courses", courses).put("meetings", meetings)
        }
        fun occursOn(term: JSONObject, meeting: JSONObject, day: LocalDate): Boolean {
            val date = day.toString()
            val exclusions = meeting.optJSONArray("exdates")
            if (exclusions != null && (0 until exclusions.length()).any { exclusions.optString(it) == date }) return false
            // A dated appointment belongs to its course but can be after the teaching term.
            if (meeting.optString("recurrence") == "once") return meeting.optString("date") == date
            if (term.optionalString("start").let { it.isNotBlank() && date < it } || term.optionalString("end").let { it.isNotBlank() && date > it } ||
                meeting.optionalString("from").let { it.isNotBlank() && date < it } || meeting.optionalString("until").let { it.isNotBlank() && date > it }) return false
            return meeting.optInt("day") == day.dayOfWeek.value
        }
        private fun courseCaption(meeting: JSONObject, courses: List<JSONObject>, full: Boolean): String {
            val course = courses.find { it.optString("code") == meeting.optString("code") }
            val code = meeting.optString("displayCode", meeting.optString("code"))
            val title = course?.optString("title").orEmpty()
            val eventTitle = meeting.optString("title")
            if (course?.optString("type") == "event") return eventTitle.ifBlank { title }.ifBlank { code }
            if (!full) return code.replace(Regex("[HY]\\d$"), "")
            val main = code
            val detail = eventTitle.takeIf { meeting.optString("recurrence") == "once" && it.isNotBlank() && it != code && it != title }
            return main + if (detail == null) "" else " · $detail"
        }
        /** A centered baseline uses actual glyph metrics; short blocks retain their time geometry. */
        fun centeredTextBaseline(top: Float, bottom: Float, ascent: Float, descent: Float): Float =
            top + (bottom - top - (descent - ascent)) / 2f - ascent
        /** Two-line room display keeps the identifying number, never a leading-only "ROOM…".
         * Measurement is injected so this policy stays pure and independent of Canvas/state.
         * When even an identifier cannot physically fit, preserve its distinguishing tail.
         */
        fun compactRoomLines(value: String, available: Float, measure: (String) -> Float): List<String> {
            val room = value.trim().replace(Regex("\\s+"), " ")
            if (room.isEmpty() || available <= 0) return emptyList()
            fun fits(text: String) = measure(text) <= available
            fun clip(text: String, keepTail: Boolean = false): String {
                if (fits(text)) return text
                if (!fits("…")) return ""
                var part = text
                while (part.isNotEmpty() && !fits(if (keepTail) "…$part" else "$part…")) {
                    part = if (keepTail) part.drop(1) else part.dropLast(1)
                }
                return if (keepTail) "…$part" else "$part…"
            }
            if (fits(room)) return listOf(room)
            val identifying = Regex("\\S*\\d\\S*").findAll(room).lastOrNull()
            if (identifying != null) {
                val token = identifying.value
                val numericTail = Regex("\\d+[A-Za-z]?(?:[-/]\\d+[A-Za-z]?)?$").find(token)?.value
                val number = if (fits(token)) token else if (numericTail != null && fits(numericTail)) numericTail else clip(token, true)
                val prefix = room.removeRange(identifying.range).trim()
                return if (prefix.isEmpty()) listOf(number) else listOf(clip(prefix), number)
            }
            val words = room.split(" ")
            var first = ""
            var used = 0
            for (word in words) {
                val next = if (first.isEmpty()) word else "$first $word"
                if (!fits(next)) break
                first = next; used++
            }
            return if (used in 1 until words.size) listOf(first, clip(words.drop(used).joinToString(" ")))
                else listOf(clip(room))
        }
        private class GridRenderer(val width: Int, val height: Int, val compact: Boolean, val term: JSONObject?, val allMeetings: List<JSONObject>, val weekStart: LocalDate, val density: Float, val selectedDay: LocalDate? = null) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            private lateinit var canvas: Canvas
            private val ink = Color.rgb(32, 53, 74)
            private data class Meeting(val source: JSONObject, val start: Int, val end: Int, val day: Int, val color: Int, val waiting: Boolean, var lane: Int = 0, var lanes: Int = 1)
            fun render(): Bitmap {
                // Render at screen density, capped at 480k RGB565 pixels (<1 MB) across all widget sizes.
                val scale = min(density.coerceIn(1f, 2f), sqrt(480000f / (width * height)))
                val bitmap = Bitmap.createBitmap(max(1, (width * scale).toInt()), max(1, (height * scale).toInt()), Bitmap.Config.RGB_565)
                canvas = Canvas(bitmap); canvas.scale(scale, scale); canvas.drawColor(Color.rgb(244, 247, 251))
                if (term == null) {
                    fitText("添加课程或日程后显示课表", 8f, max(14f, height / 2f), width - 16f, if (compact) 10f else 14f, ink)
                    return bitmap
                }
                val courses = CacheStore.objects(term.optJSONArray("courses"))
                val meetings = allMeetings.mapNotNull { m ->
                    val start = CacheStore.time(m.optString("start")) ?: return@mapNotNull null
                    val end = if (m.optString("end") == "24:00") 1440 else CacheStore.time(m.optString("end")) ?: return@mapNotNull null
                    val day = m.optInt("day")
                    if (day !in 1..7 || end <= start) return@mapNotNull null
                    val course = courses.find { it.optString("code") == m.optString("code") }
                    val custom = m.optString("color").ifBlank { course?.optString("color").orEmpty() }
                    val color = if (Regex("^#[0-9a-fA-F]{6}$").matches(custom)) Color.parseColor(custom)
                        else Color.HSVToColor(floatArrayOf(hues[max(0, courses.indexOf(course)) % hues.size], 0.58f, 0.72f))
                    Meeting(m, start, end, day, color, waiting(m) || (course != null && waiting(course)))
                }
                if (selectedDay != null) { renderDayAgenda(meetings, courses, selectedDay); return bitmap }
                if (compact) { renderAgenda(meetings, courses); return bitmap }
                val days = (1..7).toList()
                val startHour = min(9, (meetings.minOfOrNull { it.start } ?: 540) / 60)
                val endHour = max(17, ceil((meetings.maxOfOrNull { it.end } ?: 1020) / 60.0).toInt())
                val top = 22f; val bottom = height.toFloat() - 12f
                val left = if (compact) 21f else 25f
                val col = (width - left) / days.size
                val span = max(60, (endHour - startHour) * 60)
                fun y(minutes: Int) = top + (minutes - startHour * 60).toFloat() / span * (bottom - top)
                days.forEachIndexed { index, day ->
                    val date = weekStart.plusDays(day.toLong() - 1).toString()
                    val holiday = CacheStore.objects(term.optJSONArray("holidays")).any { it.optString("start") <= date && it.optString("end") >= date }
                    if (holiday) {
                        paint.color = Color.rgb(234, 236, 242)
                        canvas.drawRect(left + index * col, 0f, left + (index + 1) * col, bottom, paint)
                    }
                }
                days.forEachIndexed { index, day -> text(arrayOf("", "一", "二", "三", "四", "五", "六", "日")[day] + " " + weekStart.plusDays(day.toLong() - 1).dayOfMonth, left + index * col + col / 2 - 12, 14f, 9f, ink) }
                for (hour in startHour..endHour) {
                    val yp = y(hour * 60)
                    paint.color = Color.rgb(218, 227, 237); paint.strokeWidth = 0.6f
                    canvas.drawLine(left, yp, width.toFloat(), yp, paint)
                    if (!compact || hour % 2 == 0) text(hour.toString(), 1f, yp + 3, 8f, Color.rgb(103, 121, 140))
                }
                days.forEachIndexed { index, day ->
                    val xp = left + index * col
                    paint.color = Color.rgb(225, 232, 239); canvas.drawLine(xp, top, xp, bottom, paint)
                    layoutLanes(meetings.filter { it.day == day }).forEach { m ->
                        val x = xp + m.lane * col / m.lanes + 1
                        val w = col / m.lanes - 2
                        val rect = RectF(x, y(m.start) + 1, x + w, max(y(m.start) + 4, y(m.end) - 1))
                        paint.color = tint(m.color)
                        canvas.drawRoundRect(rect, 3f, 3f, paint)
                        if (m.waiting) {
                            paint.color = Color.rgb(164, 104, 25); paint.style = Paint.Style.STROKE
                            paint.strokeWidth = 1.2f; paint.pathEffect = DashPathEffect(floatArrayOf(3f, 2f), 0f)
                            canvas.drawRoundRect(rect, 3f, 3f, paint)
                            paint.pathEffect = null; paint.style = Paint.Style.FILL
                        }
                        paint.color = m.color
                        canvas.drawRect(rect.left, rect.top + 2, rect.left + 2, rect.bottom - 2, paint)
                        canvas.save(); canvas.clipRect(rect)
                        val label = labelFor(m, courses)
                        val room = roomFor(m)
                        val narrow = w < 35f
                        val roomSize = if (narrow) 8f else 10f
                        val titleSize = if (narrow) 7f else 9f
                        if (rect.height() < 25) {
                            // Real fifteen-minute blocks cannot hold three normal lines. Keep
                            // their exact duration and fit a concise course + room identifier.
                            paint.textSize = 8f; paint.isFakeBoldText = true
                            val identifier = compactRoomLines(room, max(10f, (w - 5) * .42f)) { paint.measureText(it) }.lastOrNull().orEmpty()
                            val compactLabel = listOf(label, identifier).filter { it.isNotBlank() }.joinToString("·")
                            val fontHeight = paint.fontMetrics.descent - paint.fontMetrics.ascent
                            val fittedSize = min(8f, min(8f * max(1f, rect.height() - 1) / fontHeight,
                                8f * max(1f, w - 5) / max(1f, paint.measureText(compactLabel))))
                            paint.textSize = fittedSize
                            val metrics = paint.fontMetrics
                            text(compactLabel, rect.left + 3,
                                centeredTextBaseline(rect.top, rect.bottom, metrics.ascent, metrics.descent), fittedSize, ink, true)
                        } else {
                            var lineY = rect.top + 11
                            paint.textSize = titleSize; paint.isFakeBoldText = true
                            val codeParts = Regex("^([A-Za-z]+)([0-9].*)$").matchEntire(label)?.groupValues?.drop(1)
                            val titleLines = if (rect.height() >= 38 && paint.measureText(label) > w - 5 && codeParts != null && codeParts.all { paint.measureText(it) <= w - 5 }) codeParts else listOf(label)
                            titleLines.forEachIndexed { index, line ->
                                if (index > 0) lineY += titleSize + 2
                                fitText(line, rect.left + 3, lineY, w - 5, titleSize, ink, true)
                            }
                            if (room.isNotBlank()) {
                                paint.textSize = roomSize; paint.isFakeBoldText = true
                                val roomLines = compactRoomLines(room, w - 5) { paint.measureText(it) }
                                paint.isFakeBoldText = false
                                val shown = if (rect.height() >= lineY - rect.top + 27) roomLines else roomLines.takeLast(1)
                                shown.forEach { line -> lineY += 11; text(line, rect.left + 3, lineY, roomSize, ink, true) }
                            }
                            if (m.waiting && rect.height() >= lineY - rect.top + 12) fitText("候补", rect.left + 3, lineY + 10, w - 5, 7f, Color.rgb(164, 104, 25))
                        }
                        canvas.restore()
                    }
                }
                if (meetings.isEmpty()) {
                    paint.color = Color.rgb(244, 247, 251)
                    canvas.drawRect(left, height / 2f - 16, width.toFloat(), height / 2f + 10, paint)
                    text("本周没有课程或日程", left + 6, height / 2f, if (compact) 9f else 12f, ink)
                }
                return bitmap
            }
            private fun labelFor(meeting: Meeting, courses: List<JSONObject>) = courseCaption(meeting.source, courses, false)
            private fun roomFor(meeting: Meeting) = meeting.source.optString("room").ifBlank { meeting.source.optString("location") }
            private fun renderDayAgenda(meetings: List<Meeting>, courses: List<JSONObject>, day: LocalDate) {
                val ordered = meetings.sortedWith(compareBy<Meeting> { it.start }.thenBy { it.end })
                if (ordered.isEmpty()) {
                    fitText("这一天没有课程或日程", 8f, max(16f, height / 2f), width - 16f, if (width >= 260) 15f else 11f, ink)
                    return
                }
                val holiday = CacheStore.objects(term?.optJSONArray("holidays")).firstOrNull { it.optString("start") <= day.toString() && it.optString("end") >= day.toString() }
                val top = if (holiday != null && height >= 120) 22f else 2f
                if (top > 2) fitText("假期标记 · ${holiday!!.optString("title")}", 8f, 14f, width - 16f, 10f, Color.rgb(103, 121, 140))
                val ideal = if (width >= 260) 88f else 76f
                var visible = max(1, ((height - top) / ideal).toInt()).coerceAtMost(ordered.size)
                if (visible < ordered.size) visible = max(1, ((height - top - 14) / ideal).toInt()).coerceAtMost(ordered.size)
                val footer = if (visible < ordered.size) 14f else 0f
                val rowHeight = min(102f, (height - top - footer) / visible)
                ordered.take(visible).forEachIndexed { index, meeting ->
                    val y = top + index * rowHeight
                    val rect = RectF(2f, y, width - 2f, y + rowHeight - 4)
                    paint.color = tint(meeting.color); canvas.drawRoundRect(rect, 5f, 5f, paint)
                    paint.color = meeting.color; canvas.drawRect(rect.left, rect.top + 3, rect.left + 3, rect.bottom - 3, paint)
                    if (meeting.waiting) {
                        paint.color = Color.rgb(164, 104, 25); paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.2f
                        paint.pathEffect = DashPathEffect(floatArrayOf(4f, 3f), 0f); canvas.drawRoundRect(rect, 5f, 5f, paint)
                        paint.pathEffect = null; paint.style = Paint.Style.FILL
                    }
                    val label = courseCaption(meeting.source, courses, true)
                    val code = labelFor(meeting, courses)
                    val room = roomFor(meeting)
                    val time = "${meeting.source.optString("start")}–${meeting.source.optString("end")}" + if (meeting.waiting) " · 候补" else ""
                    canvas.save(); canvas.clipRect(rect)
                    if (rowHeight < 50) {
                        // Only the genuinely minimum host needs this two-line compact form.
                        paint.textSize = 8f; paint.isFakeBoldText = true
                        val roomBudget = max(12f, width - 20f - paint.measureText("$code · "))
                        val identifier = compactRoomLines(room, roomBudget) { paint.measureText(it) }.lastOrNull().orEmpty()
                        fitText(listOf(code, identifier).filter { it.isNotBlank() }.joinToString(" · "), 9f, y + 10, width - 18f, 8f, ink, true)
                        fitText(time, 9f, y + 20, width - 18f, 8f, ink)
                    } else {
                        val tight = rowHeight < 76
                        val titleSize = if (tight) 11f else if (width >= 260) 15f else 13f
                        val roomSize = if (tight) 12f else if (width >= 260) 15f else 14f
                        fitText(label, 10f, y + if (tight) 15 else 21, width - 20f, titleSize, ink, true)
                        paint.textSize = roomSize; paint.isFakeBoldText = true
                        val roomLines = compactRoomLines(room, width - 20f) { paint.measureText(it) }
                        val shown = if (!tight && rowHeight >= 100) roomLines else roomLines.takeLast(1)
                        shown.forEachIndexed { line, value -> text(value, 10f, y + (if (tight) 31 else 43) + line * 18, roomSize, ink, true) }
                        val extra = max(0, shown.size - 1) * 18
                        fitText(time, 10f, y + (if (tight) 46 else 64) + extra, width - 20f, if (tight) 10f else 13f, ink)
                    }
                    canvas.restore()
                }
                if (visible < ordered.size) fitText("另 ${ordered.size - visible} 项 · 点按课表查看全部", 5f, height - 4f, width - 10f, 10f, ink)
            }
            private fun renderAgenda(meetings: List<Meeting>, courses: List<JSONObject>) {
                // All seven dates remain visible even when a short host cannot show every event.
                // Per-day overflow is explicit, so a busy weekday cannot hide an occupied weekend.
                if (height < 84) {
                    // A very short narrow host still shows every date and occupied-day count.
                    val column = width / 7f
                    (1..7).forEach { day ->
                        val entries = meetings.filter { it.day == day }
                        paint.color = entries.firstOrNull()?.let { tint(it.color) } ?: Color.rgb(238, 242, 247)
                        canvas.drawRoundRect(RectF((day - 1) * column + 1, 1f, day * column - 1, height - 1f), 2f, 2f, paint)
                        val x = (day - 1) * column + 3
                        text(weekStart.plusDays(day.toLong() - 1).dayOfMonth.toString(), x, 13f, 9f, ink)
                        fitText(if (entries.isEmpty()) "—" else "${entries.size}项", x, min(height - 6f, 36f), column - 4f, 9f, ink, entries.isNotEmpty())
                        if (height >= 58 && entries.isNotEmpty()) {
                            paint.textSize = 8f; paint.isFakeBoldText = true
                            val room = compactRoomLines(roomFor(entries.first()), column - 4f) { paint.measureText(it) }.lastOrNull().orEmpty()
                            text(room, x, min(height - 6f, 57f), 8f, ink, true)
                        }
                    }
                    return
                }
                val row = height / 7f
                (1..7).forEach { day ->
                    val top = (day - 1) * row
                    val entries = meetings.filter { it.day == day }.sortedBy { it.start }
                    val first = entries.firstOrNull()
                    paint.color = if (first == null) Color.rgb(238, 242, 247) else tint(first.color)
                    canvas.drawRoundRect(RectF(0f, top + 1, width.toFloat(), top + row - 1), 2f, 2f, paint)
                    val date = weekStart.plusDays(day.toLong() - 1)
                    val baseline = top + min(12f, row - 2)
                    text("${date.monthValue}/${date.dayOfMonth}", 3f, baseline, 8f, ink)
                    if (first != null) {
                        val course = courses.find { it.optString("code") == first.source.optString("code") }
                        val title = first.source.optString("title").ifBlank {
                            if (course?.optString("type") == "event") course.optString("title") else first.source.optString("displayCode").replace(Regex("[HY]\\d$"), "")
                        }
                        val room = first.source.optString("room").ifBlank { first.source.optString("location") }
                        val more = if (entries.size > 1) " +${entries.size - 1}" else ""
                        paint.textSize = 8f; paint.isFakeBoldText = true
                        val identifier = compactRoomLines(room, width - 37f) { paint.measureText(it) }.lastOrNull().orEmpty()
                        val destination = if (identifier.isBlank()) title else "$identifier · $title"
                        fitText((if (first.waiting) "候补 " else "") + destination + more, 34f, baseline, width - 37f, 8f, ink, true)
                        if (row >= 26) fitText("${first.source.optString("start")}–${first.source.optString("end")}$more", 34f, top + 24, width - 37f, 8f, ink)
                        if (entries.size > 1) { // Reserve a visible count independently of title truncation.
                            paint.color = tint(first.color); canvas.drawRect(width - 22f, top + 1, width.toFloat(), top + row - 1, paint)
                            text("+${entries.size - 1}", width - 20f, baseline, 8f, ink, true)
                        }
                    } else fitText("—", 34f, baseline, width - 37f, 8f, Color.rgb(103, 121, 140))
                }
            }
            private fun layoutLanes(items: List<Meeting>): List<Meeting> {
                val sorted = items.sortedWith(compareBy<Meeting> { it.start }.thenByDescending { it.end })
                var cluster = mutableListOf<Meeting>(); var clusterEnd = -1
                fun flush() {
                    val ends = mutableListOf<Int>()
                    cluster.forEach { meeting ->
                        var lane = ends.indexOfFirst { it <= meeting.start }
                        if (lane < 0) { lane = ends.size; ends.add(0) }
                        ends[lane] = meeting.end; meeting.lane = lane
                    }
                    cluster.forEach { it.lanes = max(1, ends.size) }; cluster = mutableListOf()
                }
                sorted.forEach { meeting ->
                    if (cluster.isNotEmpty() && meeting.start >= clusterEnd) { flush(); clusterEnd = -1 }
                    cluster.add(meeting); clusterEnd = max(clusterEnd, meeting.end)
                }
                flush(); return sorted
            }
            private fun tint(color: Int) = Color.rgb((Color.red(color) * .15 + 255 * .85).toInt(), (Color.green(color) * .15 + 255 * .85).toInt(), (Color.blue(color) * .15 + 255 * .85).toInt())
            private fun text(value: String, x: Float, y: Float, size: Float, color: Int, bold: Boolean = false) {
                paint.textSize = size; paint.color = color; paint.isFakeBoldText = bold; canvas.drawText(value, x, y, paint); paint.isFakeBoldText = false
            }
            private fun fitText(value: String, x: Float, y: Float, available: Float, size: Float, color: Int, bold: Boolean = false) {
                if (available <= 3) return
                paint.textSize = size; paint.isFakeBoldText = bold
                val count = paint.breakText(value, true, available, null)
                val display = if (count < value.length && count > 1) value.take(count - 1) + "…" else value.take(count)
                text(display, x, y, size, color, bold)
            }
        }
    }
}
