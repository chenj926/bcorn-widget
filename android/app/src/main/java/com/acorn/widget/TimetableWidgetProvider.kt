package com.acorn.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Bundle
import android.widget.RemoteViews
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/** Event-driven RemoteViews widget. No alarms, workers, service, polling or network. */
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
            val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 350).coerceIn(160, 520)
            val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 490).coerceIn(150, 700)
            val data = CacheStore.read(context)
            val terms = CacheStore.objects(data?.optJSONArray("terms"))
            val today = LocalDate.now(ZoneId.of("America/Toronto")).toString()
            val term = terms.find { it.optString("start") <= today && it.optString("end") >= today }
                ?: terms.filter { it.optString("start") > today }.minByOrNull { it.optString("start") }
                ?: terms.lastOrNull()
            val compact = width < 260 || height < 260
            val grid = GridRenderer(width - 16, max(90, height - 62), compact, term).render()
            val views = RemoteViews(context.packageName, R.layout.timetable_widget)
            views.setTextViewText(R.id.widget_title, "ACORN · ${term?.optString("name") ?: "课表"}")
            views.setImageViewBitmap(R.id.widget_grid, grid)
            val date = data?.optionalString("modifiedAt")?.take(10)?.takeIf { it.isNotBlank() }
                ?: data?.optionalString("fetchedAt")?.take(10)?.takeIf { it.isNotBlank() }
            val courses = CacheStore.objects(term?.optJSONArray("courses"))
            val meetings = CacheStore.objects(term?.optJSONArray("meetings"))
            val waitCodes = courses.filter { waiting(it) }.map { it.optString("code") }.toSet() + meetings.filter { waiting(it) }.map { it.optString("code") }
            val tbaCount = courses.count { course -> meetings.none { it.optString("code") == course.optString("code") && CacheStore.time(it.optString("start")) != null } }
            val summary = meetings.take(60).joinToString("；") { m ->
                "${m.optString("code")} ${if (m.optString("code") in waitCodes) "候补 " else ""}周${m.optInt("day")} ${m.optString("start")}至${m.optString("end")} ${m.optString("location")}" }
            views.setContentDescription(R.id.widget_grid, "${term?.optString("name") ?: "暂无数据"}，学期周课表。候补 ${waitCodes.size} 门，时间待定 $tbaCount 门。$summary。点按打开完整课表。")
            views.setTextViewText(R.id.widget_hint, if (term == null) "点按打开应用，从菜单导入 JSON" else "本地周课表${if (date != null) " · $date" else ""} · 候补 ${waitCodes.size} · 待定 $tbaCount\n点按打开课表 · 桌面长按调整大小")
            views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, id,
                Intent(context, MainActivity::class.java).putExtra("openTerm", true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            // Widget intentionally shows a static semester template, never a stale 'now' indicator.
            manager.updateAppWidget(id, views)
        }
        private class GridRenderer(val width: Int, val height: Int, val compact: Boolean, val term: JSONObject?) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            private lateinit var canvas: Canvas
            private val ink = Color.rgb(32, 53, 74)
            private data class Meeting(val source: JSONObject, val start: Int, val end: Int, val day: Int, val hue: Float, val waiting: Boolean, var lane: Int = 0, var lanes: Int = 1)
            fun render(): Bitmap {
                // RGB565 plus bounded pixels keeps RemoteViews below Binder bitmap limits.
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
                canvas = Canvas(bitmap); canvas.drawColor(Color.rgb(244, 247, 251))
                if (term == null) {
                    text("导入课表后显示周课表", 12f, height / 2f, if (compact) 11f else 14f, ink)
                    return bitmap
                }
                val courses = CacheStore.objects(term.optJSONArray("courses"))
                val allMeetings = CacheStore.objects(term.optJSONArray("meetings"))
                val meetings = allMeetings.mapNotNull { m ->
                    val start = CacheStore.time(m.optString("start")) ?: return@mapNotNull null
                    val end = CacheStore.time(m.optString("end")) ?: return@mapNotNull null
                    val day = m.optInt("day")
                    if (day !in 1..7 || end <= start) return@mapNotNull null
                    Meeting(m, start, end, day, hues[max(0, courses.indexOfFirst { it.optString("code") == m.optString("code") }) % hues.size], waiting(m) || courses.any { it.optString("code") == m.optString("code") && waiting(it) })
                }
                if (meetings.isEmpty()) { text("暂无已排时间 · 点按查看课程", 8f, height / 2f, 11f, ink); return bitmap }
                val days = (1..5).toList() + (6..7).filter { day -> meetings.any { it.day == day } }
                val startHour = min(9, meetings.minOf { it.start } / 60)
                val endHour = max(17, ceil(meetings.maxOf { it.end } / 60.0).toInt())
                val top = 22f; val bottom = height.toFloat() - 12f
                val left = if (compact) 21f else 25f
                val col = (width - left) / days.size
                val span = max(60, (endHour - startHour) * 60)
                fun y(minutes: Int) = top + (minutes - startHour * 60).toFloat() / span * (bottom - top)
                days.forEachIndexed { index, day -> text(arrayOf("", "一", "二", "三", "四", "五", "六", "日")[day], left + index * col + col / 2 - 5, 14f, 10f, ink) }
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
                        val code = (if (m.waiting) "候补 " else "") + m.source.optString("code").replace(Regex("[HY]\\d$"), "")
                        var lineY = rect.top + (if (compact) 9 else 11)
                        fitText(code, rect.left + 4, lineY, w - 5, if (compact) 8f else 10f, ink, true)
                        if (!compact && rect.height() >= 24) { lineY += 11; fitText(m.source.optString("kind", m.source.optString("section")), rect.left + 4, lineY, w - 5, 8f, ink) }
                        if (!compact && rect.height() >= 38) { lineY += 11; fitText(m.source.optString("location"), rect.left + 4, lineY, w - 5, 8f, ink) }
                        if (!compact && rect.height() >= 51) { lineY += 11; fitText("${m.source.optString("start")}–${m.source.optString("end")}", rect.left + 4, lineY, w - 5, 7f, ink) }
                        canvas.restore()
                    }
                }
                return bitmap
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
