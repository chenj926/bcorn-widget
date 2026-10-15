package io.bcorn.mobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

class TimetableWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        refreshAll(context)
    }

    override fun onEnabled(context: Context) = scheduleBoundary(context)
    override fun onDisabled(context: Context) = cancelBoundary(context)

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        scheduleBoundary(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        render(context, manager, id, options)
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_REFRESH, ACTION_BOUNDARY,
            Intent.ACTION_DATE_CHANGED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_LOCALE_CHANGED -> refreshAll(context)
            else -> super.onReceive(context, intent)
        }
    }

    companion object {
        private const val ACTION_REFRESH = "io.bcorn.mobile.REFRESH_WIDGET"
        private const val ACTION_BOUNDARY = "io.bcorn.mobile.WIDGET_BOUNDARY"
        private const val ALARM_ID = 0xBC01
        internal const val MAX_VISIBLE_ROWS = 60
        private val chinese = Locale.SIMPLIFIED_CHINESE
        private val dateFormat = DateTimeFormatter.ofPattern("M月d日 · yyyy", chinese)
        private val weekdayFormat = DateTimeFormatter.ofPattern("EEEE", chinese)
        private val timeFormat = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT)

        /** A saved snapshot remains successful even if a particular launcher rejects an update. */
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, TimetableWidgetProvider::class.java))
            ids.forEach { id ->
                try {
                    render(context, manager, id, manager.getAppWidgetOptions(id))
                } catch (error: RuntimeException) {
                    Log.w("BcornWidget", "Launcher update failed for widget $id", error)
                }
            }
            scheduleBoundary(context)
        }

        @Suppress("DEPRECATION")
        private fun render(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
            val now = LocalDateTime.now()
            val snapshot = TimetableStore.snapshot(context)
            val today = snapshot.today(now)
            val minutes = now.hour * 60 + now.minute
            val current = today.filter { it.isCurrent(minutes) }
            val next = today.firstOrNull { it.startMinutes > minutes }
            val focusCourse = current.firstOrNull() ?: next
            val views = RemoteViews(context.packageName, R.layout.timetable_widget)
            val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 400)
            val compact = minHeight in 1..300
            views.setViewVisibility(R.id.widget_brand, if (compact) View.GONE else View.VISIBLE)
            views.setViewVisibility(R.id.widget_date, if (compact) View.GONE else View.VISIBLE)
            views.setViewVisibility(R.id.widget_current_detail, if (compact) View.GONE else View.VISIBLE)
            val padding = (if (compact) 12 else 16) * context.resources.displayMetrics.density
            views.setViewPadding(R.id.widget_root, padding.toInt(), padding.toInt(), padding.toInt(), padding.toInt())
            views.setTextViewText(R.id.widget_date, now.format(dateFormat))
            views.setTextViewText(R.id.widget_weekday, now.format(weekdayFormat))
            views.setTextViewText(R.id.widget_count, if (today.size > MAX_VISIBLE_ROWS) {
                "今天 ${today.size} 节 · 下滑查看更多"
            } else context.getString(R.string.widget_course_count, today.size))
            views.setTextViewText(R.id.widget_updated, context.getString(R.string.widget_updated, now.format(timeFormat)))

            val status: String
            val title: String
            val detail: String
            when {
                snapshot.invalid -> {
                    status = "课表需要检查"; title = "打开应用查看数据"; detail = "已保存的数据没有被改写"
                }
                !snapshot.hasSavedData || snapshot.courses.isEmpty() -> {
                    status = "从一节课开始"; title = "添加课程，让今天更从容"; detail = "点击小组件打开课表"
                }
                current.isNotEmpty() -> {
                    status = context.getString(R.string.widget_current) + if (current.size > 1) " · ${current.size} 节重叠" else ""
                    title = current.first().title
                    detail = "${current.first().timeRange} · ${current.first().location.ifBlank { "地点待填写" }}"
                }
                next != null -> {
                    status = context.getString(R.string.widget_next); title = next.title
                    detail = "${next.timeRange} · ${next.location.ifBlank { "地点待填写" }}"
                }
                today.isNotEmpty() -> {
                    status = "今天辛苦了"; title = context.getString(R.string.widget_finished); detail = "你可以在应用里查看整周课表"
                }
                else -> {
                    status = "今天的安排"; title = "今日无课"; detail = "留一点时间给自己"
                }
            }
            views.setTextViewText(R.id.widget_status, status)
            views.setTextViewText(R.id.widget_current_title, title)
            views.setTextViewText(R.id.widget_current_detail, detail)
            val nextLine = when {
                current.isNotEmpty() && next != null -> "下一节 ${formatMinutes(next.startMinutes)} · ${next.title}"
                current.isNotEmpty() -> context.getString(R.string.widget_no_next)
                next != null -> "${next.timeRange} · ${next.location.ifBlank { "地点待填写" }}"
                snapshot.invalid -> "点击打开应用检查"
                else -> "本地保存 · 点课程查看详情"
            }
            views.setTextViewText(R.id.widget_next_line, nextLine)
            views.setTextViewText(R.id.widget_empty, context.getString(when {
                snapshot.invalid -> R.string.widget_invalid
                !snapshot.hasSavedData || snapshot.courses.isEmpty() -> R.string.widget_setup
                else -> R.string.widget_empty
            }))
            val openApp = PendingIntent.getActivity(context, id, Intent(context, MainActivity::class.java).apply {
                action = "io.bcorn.mobile.OPEN_WIDGET.$id"
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_header, openApp)
            views.setOnClickPendingIntent(R.id.widget_empty, openApp)
            views.setOnClickPendingIntent(R.id.widget_updated, openApp)
            val focusIntent = if (focusCourse == null) openApp else PendingIntent.getActivity(
                context, id, Intent(context, WidgetLinkActivity::class.java).apply {
                    action = "io.bcorn.mobile.FOCUS_WIDGET.$id"
                    putExtra(WidgetLinkActivity.EXTRA_COURSE_ID, focusCourse.id)
                }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.widget_focus, focusIntent)
            views.setOnClickPendingIntent(R.id.widget_refresh, PendingIntent.getBroadcast(context, id,
                Intent(context, TimetableWidgetProvider::class.java).setAction(ACTION_REFRESH),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

            // Only this explicit PendingIntent is mutable: the launcher fills in the selected ID.
            val templateFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val template = PendingIntent.getActivity(context, id, Intent(context, WidgetLinkActivity::class.java).apply {
                action = "io.bcorn.mobile.COURSE_WIDGET.$id"
                data = Uri.parse("bcorn-widget://courses/$id")
            }, templateFlags)
            views.setPendingIntentTemplate(R.id.widget_list, template)
            views.setEmptyView(R.id.widget_list, R.id.widget_empty)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Modern direct collections avoid deprecated remote-adapter refresh behavior on Android 15+.
                val items = RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(false).setViewTypeCount(1)
                today.take(MAX_VISIBLE_ROWS).forEachIndexed { index, course ->
                    items.addItem(index.toLong(), WidgetRows.course(context, course, minutes))
                }
                if (today.size > MAX_VISIBLE_ROWS) items.addItem(Long.MAX_VALUE,
                    WidgetRows.overflow(context, today.size - MAX_VISIBLE_ROWS))
                views.setRemoteAdapter(R.id.widget_list, items.build())
            } else {
                val service = Intent(context, TimetableRemoteViewsService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                    data = Uri.parse("bcorn-widget://adapter/$id")
                }
                views.setRemoteAdapter(R.id.widget_list, service)
            }
            manager.updateAppWidget(id, views)
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) manager.notifyAppWidgetViewDataChanged(id, R.id.widget_list)
        }

        private fun alarmIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, ALARM_ID, Intent(context, TimetableWidgetProvider::class.java).setAction(ACTION_BOUNDARY),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        internal fun scheduleBoundary(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            if (manager.getAppWidgetIds(ComponentName(context, TimetableWidgetProvider::class.java)).isEmpty()) {
                cancelBoundary(context)
                return
            }
            val now = LocalDateTime.now()
            var boundary = now.toLocalDate().plusDays(1).atStartOfDay()
            TimetableStore.snapshot(context).today(now).forEach { course ->
                listOf(course.startMinutes, course.endMinutes).forEach { minute ->
                    val candidate = now.toLocalDate().atStartOfDay().plusMinutes(minute.toLong())
                    if (candidate.isAfter(now) && candidate.isBefore(boundary)) boundary = candidate
                }
            }
            try {
                // Deliberately inexact and non-wakeup. No exact-alarm or battery exemption permission.
                // A sleeping/throttled phone can delay it; 30-minute provider updates remain the fallback.
                (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).set(
                    AlarmManager.RTC,
                    boundary.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli(),
                    alarmIntent(context),
                )
            } catch (error: RuntimeException) {
                Log.w("BcornWidget", "Boundary refresh could not be scheduled", error)
            }
        }

        private fun cancelBoundary(context: Context) {
            (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(alarmIntent(context))
        }
    }
}
