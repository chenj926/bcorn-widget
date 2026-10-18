package com.acorn.widget

import android.content.Context
import com.acorn.widget.calendar.CalendarBridge
import org.json.JSONObject
import java.util.concurrent.Executors

/** One process-wide writer owns provider sequencing across Activity recreation. */
object NativeCalendarGateway {
    val methods = setOf("calendarStatus", "listCalendars", "selectCalendar", "syncCalendarEvent", "removeCalendarEvent")
    private val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "bcorn-calendar").apply { isDaemon = true } }
    private var bridge: CalendarBridge? = null
    fun call(context: Context, method: String, arguments: JSONObject, complete: (JSONObject) -> Unit) {
        require(method in methods)
        val application = context.applicationContext
        executor.execute {
            val facade = bridge ?: CalendarBridge(application).also { bridge = it }
            complete(facade.call(method, arguments))
        }
    }
}
