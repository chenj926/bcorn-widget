package io.bcorn.mobile

import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import java.time.LocalDateTime

/** Android 6–11 fallback. Android 12+ uses inline RemoteCollectionItems. */
class TimetableRemoteViewsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)

    private class Factory(private val context: Context) : RemoteViewsFactory {
        private var today = emptyList<Course>()
        private var minutes = 0

        override fun onCreate() = onDataSetChanged()
        override fun onDataSetChanged() {
            val now = LocalDateTime.now()
            minutes = now.hour * 60 + now.minute
            today = TimetableStore.snapshot(context).today(now)
        }
        override fun onDestroy() { today = emptyList() }
        override fun getCount(): Int = minOf(today.size, TimetableWidgetProvider.MAX_VISIBLE_ROWS) +
            if (today.size > TimetableWidgetProvider.MAX_VISIBLE_ROWS) 1 else 0
        override fun getViewAt(position: Int): RemoteViews? {
            if (position < 0 || position >= getCount()) return null
            if (position == TimetableWidgetProvider.MAX_VISIBLE_ROWS) {
                return WidgetRows.overflow(context, today.size - TimetableWidgetProvider.MAX_VISIBLE_ROWS)
            }
            return WidgetRows.course(context, today[position], minutes)
        }
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount(): Int = 1
        override fun getItemId(position: Int): Long = position.toLong()
        override fun hasStableIds(): Boolean = false
    }
}
