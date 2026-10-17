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
    companion object {
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
                    setOnClickPendingIntent(R.id.widget_root, openApp(context, id))
                }
            }
            manager.updateAppWidget(id, views)
        }
        private fun openApp(context: Context, id: Int): PendingIntent = PendingIntent.getActivity(context, id,
            Intent(context, MainActivity::class.java).putExtra("openTerm", true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        /** Deterministic entry point also exercised by the Android RemoteViews host test. */
        fun createViews(context: Context, id: Int, width: Int, height: Int, data: JSONObject?, dateOverride: LocalDate? = null): RemoteViews {
            val terms = CacheStore.objects(data?.optJSONArray("terms"))
            fun todayFor(t: JSONObject): LocalDate = dateOverride ?: LocalDate.now(try { ZoneId.of(t.optString("timezone", "America/Toronto")) } catch (_: Exception) { ZoneId.of("America/Toronto") })
            val active = terms.filter { val day = todayFor(it).toString(); it.optString("start") <= day && it.optString("end") >= day }
            val primary = active.firstOrNull { !it.optString("id").startsWith("personal-") && CacheStore.objects(it.optJSONArray("courses")).any { course -> course.optString("type") != "event" } }
                ?: active.firstOrNull()
                ?: terms.filter { it.optString("start") > todayFor(it).toString() }.minByOrNull { it.optString("start") }
                ?: terms.maxByOrNull { it.optString("end") }
            val today = primary?.let { todayFor(it) } ?: dateOverride ?: LocalDate.now(ZoneId.of("America/Toronto"))
            val weekStart = today.minusDays(today.dayOfWeek.value.toLong() - 1)
            val displayZone = primary?.let { zone(it) } ?: ZoneId.of("America/Toronto")
            val term = primary?.let { weekModel(terms, it, weekStart, displayZone) }
            val compact = width < 260 || height < 260
            val allMeetings = CacheStore.objects(term?.optJSONArray("meetings"))
            val meetings = if (term == null) emptyList() else allMeetings.filter { m ->
                (0L..6L).any { offset -> occursOn(term, m, weekStart.plusDays(offset)) }
            }
            val grid = GridRenderer(width - 16, max(64, height - 86), compact, term, meetings, weekStart, context.resources.displayMetrics.density).render()
            val views = RemoteViews(context.packageName, R.layout.timetable_widget)
            views.setTextViewText(R.id.widget_title, "bcorn · ${term?.optString("name") ?: "课表"}")
            views.setTextViewText(R.id.widget_week, "${weekStart} — ${weekStart.plusDays(6)}\n${term?.optString("timezone", "America/Toronto") ?: "America/Toronto"}")
            views.setViewVisibility(R.id.widget_placeholder, View.GONE)
            views.setViewVisibility(R.id.widget_grid, View.VISIBLE)
            views.setImageViewBitmap(R.id.widget_grid, grid)
            val courses = CacheStore.objects(term?.optJSONArray("courses"))
            val waitCodes = courses.filter { waiting(it) }.map { it.optString("code") }.toSet() + allMeetings.filter { waiting(it) }.map { it.optString("code") }
            val tbaCount = courses.count { !it.optBoolean("widgetScheduled") }
            val summary = meetings.take(60).joinToString("；") { m ->
                "${m.optString("title", m.optString("code"))} ${if (m.optString("code") in waitCodes) "候补 " else ""}${if (m.optString("recurrence") == "once") m.optString("date") else "周${m.optInt("day")}"} ${m.optString("start")}至${m.optString("end")} ${m.optString("location")}" }
            views.setContentDescription(R.id.widget_grid, "${weekStart}至${weekStart.plusDays(6)}，${term?.optString("name") ?: "暂无数据"}。候补 ${waitCodes.size} 门，时间待定 $tbaCount 门。$summary。点按打开完整课表。")
            views.setTextViewText(R.id.widget_hint, if (term == null) "点按打开，添加课程或日程" else "本地周课表 · 候补 ${waitCodes.size} · 待定 $tbaCount\n点按打开 · 长按调整大小 · 系统每日更新")
            views.setOnClickPendingIntent(R.id.widget_root, openApp(context, id))
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
            val weekEnd = weekStart.plusDays(7)
            val formatter = DateTimeFormatter.ofPattern("HH:mm", java.util.Locale.ROOT)
            terms.forEachIndexed { index, source ->
                val sourceCourses = CacheStore.objects(source.optJSONArray("courses"))
                    .filter { source === primary || it.optString("type") == "event" }
                val codes = sourceCourses.map { it.optString("code") }.toSet()
                val sourceMeetings = CacheStore.objects(source.optJSONArray("meetings"))
                val scheduledCodes = sourceMeetings.filter { CacheStore.time(it.optString("start")) != null && CacheStore.time(it.optString("end")) != null }.map { it.optString("code") }.toSet()
                sourceCourses.forEach { course -> courses.put(JSONObject(course.toString())
                    .put("displayCode", course.optString("code")).put("code", "$index:${course.optString("code")}")
                    .put("widgetScheduled", course.optString("code") in scheduledCodes)) }
                val sourceZone = zone(source)
                val firstSourceDay = weekStart.atStartOfDay(displayZone).withZoneSameInstant(sourceZone).toLocalDate()
                val lastSourceDay = weekEnd.atStartOfDay(displayZone).minusNanos(1).withZoneSameInstant(sourceZone).toLocalDate()
                sourceMeetings.filter { it.optString("code") in codes }.forEach meetingLoop@ { meeting ->
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
            if (term.optionalString("start").let { it.isNotBlank() && date < it } || term.optionalString("end").let { it.isNotBlank() && date > it } ||
                meeting.optionalString("from").let { it.isNotBlank() && date < it } || meeting.optionalString("until").let { it.isNotBlank() && date > it }) return false
            val exclusions = meeting.optJSONArray("exdates")
            if (exclusions != null && (0 until exclusions.length()).any { exclusions.optString(it) == date }) return false
            return if (meeting.optString("recurrence") == "once") meeting.optString("date") == date else meeting.optInt("day") == day.dayOfWeek.value
        }
        private class GridRenderer(val width: Int, val height: Int, val compact: Boolean, val term: JSONObject?, val allMeetings: List<JSONObject>, val weekStart: LocalDate, val density: Float) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            private lateinit var canvas: Canvas
            private val ink = Color.rgb(32, 53, 74)
            private data class Meeting(val source: JSONObject, val start: Int, val end: Int, val day: Int, val hue: Float, val waiting: Boolean, var lane: Int = 0, var lanes: Int = 1)
            fun render(): Bitmap {
                // Render at screen density, capped at 480k RGB565 pixels (<1 MB) across all widget sizes.
                val scale = min(density.coerceIn(1f, 2f), sqrt(480000f / (width * height)))
                val bitmap = Bitmap.createBitmap(max(1, (width * scale).toInt()), max(1, (height * scale).toInt()), Bitmap.Config.RGB_565)
                canvas = Canvas(bitmap); canvas.scale(scale, scale); canvas.drawColor(Color.rgb(244, 247, 251))
                if (term == null) {
                    text("添加课程或日程后显示课表", 12f, height / 2f, if (compact) 11f else 14f, ink)
                    return bitmap
                }
                val courses = CacheStore.objects(term.optJSONArray("courses"))
                val meetings = allMeetings.mapNotNull { m ->
                    val start = CacheStore.time(m.optString("start")) ?: return@mapNotNull null
                    val end = if (m.optString("end") == "24:00") 1440 else CacheStore.time(m.optString("end")) ?: return@mapNotNull null
                    val day = m.optInt("day")
                    if (day !in 1..7 || end <= start) return@mapNotNull null
                    Meeting(m, start, end, day, hues[max(0, courses.indexOfFirst { it.optString("code") == m.optString("code") }) % hues.size], waiting(m) || courses.any { it.optString("code") == m.optString("code") && waiting(it) })
                }
                if (compact) { renderAgenda(meetings, courses); return bitmap }
                val days = (1..5).toList() + (6..7).filter { day -> meetings.any { it.day == day } }
                val startHour = min(9, (meetings.minOfOrNull { it.start } ?: 540) / 60)
                val endHour = max(17, ceil((meetings.maxOfOrNull { it.end } ?: 1020) / 60.0).toInt())
                val top = 22f; val bottom = height.toFloat() - 12f
                val left = if (compact) 21f else 25f
                val col = (width - left) / days.size
                val span = max(60, (endHour - startHour) * 60)
                fun y(minutes: Int) = top + (minutes - startHour * 60).toFloat() / span * (bottom - top)
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
                        paint.color = Color.HSVToColor(floatArrayOf(m.hue, 0.15f, 0.98f))
                        canvas.drawRoundRect(rect, 3f, 3f, paint)
                        if (m.waiting) {
                            paint.color = Color.rgb(164, 104, 25); paint.style = Paint.Style.STROKE
                            paint.strokeWidth = 1.2f; paint.pathEffect = DashPathEffect(floatArrayOf(3f, 2f), 0f)
                            canvas.drawRoundRect(rect, 3f, 3f, paint)
                            paint.pathEffect = null; paint.style = Paint.Style.FILL
                        }
                        paint.color = Color.HSVToColor(floatArrayOf(m.hue, 0.58f, 0.72f))
                        canvas.drawRect(rect.left, rect.top + 2, rect.left + 2, rect.bottom - 2, paint)
                        canvas.save(); canvas.clipRect(rect)
                        val course = courses.find { it.optString("code") == m.source.optString("code") }
                        val label = if (course?.optString("type") == "event") course.optString("title").takeIf { it.isNotBlank() } ?: m.source.optString("title").takeIf { it.isNotBlank() } ?: m.source.optString("code") else m.source.optString("displayCode", m.source.optString("code")).replace(Regex("[HY]\\d$"), "")
                        if (w < 40f) {
                            // Overlap lanes should show a short code/time, not four rows of ellipses.
                            paint.textSize = 8f
                            val count = paint.breakText(label, true, max(1f, w - 6), null).coerceAtLeast(1)
                            text(label.take(count), rect.left + 3, rect.top + 10, 8f, ink, true)
                            if (rect.height() >= 22) fitText(label.drop(count), rect.left + 3, rect.top + 20, w - 6, 8f, ink, true)
                            if (rect.height() >= 33) fitText(m.source.optString("start").removePrefix("0"), rect.left + 3, rect.top + 31, w - 6, 6.5f, ink)
                            if (rect.height() >= 44) fitText(m.source.optString("end").removePrefix("0"), rect.left + 3, rect.top + 41, w - 6, 6.5f, ink)
                            if (m.waiting && rect.height() >= 55) fitText("候补", rect.left + 3, rect.top + 52, w - 6, 8f, Color.rgb(164, 104, 25))
                        } else {
                            val code = (if (m.waiting) "候补 " else "") + label
                            var lineY = rect.top + 11
                            fitText(code, rect.left + 4, lineY, w - 5, 10f, ink, true)
                            if (rect.height() >= 24) { lineY += 11; fitText(m.source.optString("start") + "–" + m.source.optString("end"), rect.left + 4, lineY, w - 5, 7f, ink) }
                            if (rect.height() >= 38) { lineY += 11; fitText(if (m.source.optString("recurrence") == "once") "单次 · ${m.source.optString("date").takeLast(5)}" else m.source.optString("kind", m.source.optString("section")), rect.left + 4, lineY, w - 5, 8f, ink) }
                            if (rect.height() >= 51) { lineY += 11; fitText(m.source.optString("location"), rect.left + 4, lineY, w - 5, 8f, ink) }
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
            private fun renderAgenda(meetings: List<Meeting>, courses: List<JSONObject>) {
                if (meetings.isEmpty()) { fitText("本周没有课程或日程", 4f, height / 2f, width - 8f, 11f, ink); return }
                val ordered = meetings.sortedWith(compareBy<Meeting> { it.day }.thenBy { it.start })
                text("本周日程 · ${ordered.size} 项", 3f, 12f, 10f, ink, true)
                val visible = max(1, (height - 30) / 32).coerceAtMost(12)
                ordered.take(visible).forEachIndexed { index, m ->
                    val top = 18f + index * 32f
                    paint.color = Color.HSVToColor(floatArrayOf(m.hue, 0.13f, 0.98f))
                    canvas.drawRoundRect(RectF(1f, top, width - 1f, top + 29), 3f, 3f, paint)
                    val course = courses.find { it.optString("code") == m.source.optString("code") }
                    val label = if (course?.optString("type") == "event") course.optString("title").ifBlank { m.source.optString("displayCode") }
                        else m.source.optString("displayCode", m.source.optString("code")).replace(Regex("[HY]\\d$"), "")
                    fitText((if (m.waiting) "候补 · " else "") + label, 5f, top + 11, width - 10f, 10f, ink, true)
                    val day = weekStart.plusDays(m.day.toLong() - 1)
                    fitText("${day.monthValue}/${day.dayOfMonth} ${m.source.optString("start")}–${m.source.optString("end")}${if (m.source.optString("recurrence") == "once") " · 单次" else ""}", 5f, top + 24, width - 10f, 9f, ink)
                }
                if (ordered.size > visible) fitText("另 ${ordered.size - visible} 项 · 点按查看全部", 3f, height - 2f, width - 6f, 9f, Color.rgb(88, 107, 126))
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
