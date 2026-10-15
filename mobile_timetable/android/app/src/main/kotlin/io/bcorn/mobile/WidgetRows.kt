package io.bcorn.mobile

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.widget.RemoteViews

internal object WidgetRows {
    fun course(context: Context, course: Course, minutes: Int): RemoteViews {
        val active = course.isCurrent(minutes)
        val ended = course.endMinutes <= minutes
        val views = RemoteViews(context.packageName, R.layout.timetable_widget_row)
        views.setInt(R.id.row_root, "setBackgroundResource", if (active) R.drawable.widget_row_current else R.drawable.widget_row_background)
        views.setTextViewText(R.id.row_start, formatMinutes(course.startMinutes))
        views.setTextViewText(R.id.row_end, formatMinutes(course.endMinutes))
        views.setTextViewText(R.id.row_title, course.title)
        views.setTextViewText(R.id.row_location, course.location.ifBlank { context.getString(R.string.widget_location_unset) })
        val state = context.getString(when {
            active -> R.string.widget_current
            ended -> R.string.widget_ended
            else -> R.string.widget_upcoming
        })
        val action = context.getString(R.string.widget_open_app)
        views.setTextViewText(R.id.row_status, "$state · $action")
        // Force the color strip opaque; imported alpha never makes it disappear.
        views.setInt(R.id.row_accent, "setBackgroundColor", course.color or Color.BLACK)
        views.setTextColor(R.id.row_title, Color.parseColor(if (ended) "#75817E" else "#172B43"))
        views.setContentDescription(R.id.row_root, "${course.timeRange}，${course.title}，${course.location}，$state，$action")
        views.setOnClickFillInIntent(R.id.row_root, Intent().putExtra(WidgetLinkActivity.EXTRA_COURSE_ID, course.id))
        return views
    }

    fun overflow(context: Context, count: Int): RemoteViews =
        RemoteViews(context.packageName, R.layout.timetable_widget_row).apply {
            setTextViewText(R.id.row_start, "···")
            setTextViewText(R.id.row_end, "")
            setTextViewText(R.id.row_title, "还有 $count 节课程")
            setTextViewText(R.id.row_location, "点击打开应用，查看完整课表")
            setTextViewText(R.id.row_status, "小组件最多展示前 60 节")
            setOnClickFillInIntent(R.id.row_root, Intent().putExtra(WidgetLinkActivity.EXTRA_COURSE_ID, ""))
        }
}
