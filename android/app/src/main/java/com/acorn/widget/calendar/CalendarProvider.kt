package com.acorn.widget.calendar

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Reminders

/** The only boundary allowed to touch CalendarProvider. No network, service or polling. */
data class WritableCalendar(val id: Long, val name: String, val account: String, val accountType: String,
    val maxReminders: Int, val reminderMethods: Set<Int>) {
    val identity: String get() = "$id\n$accountType\n$account"
}
data class CalendarWrite(val title: String, val description: String, val location: String,
    val occurrence: CalendarOccurrence, val reminders: List<Int>)
interface CalendarProvider {
    fun hasPermission(): Boolean
    fun calendars(): List<WritableCalendar>
    fun findOwned(calendarId: Long, marker: String): List<Long>
    fun isOwned(calendarId: Long, eventId: Long, marker: String): Boolean
    fun write(calendarId: Long, eventId: Long?, marker: String, event: CalendarWrite): Long
    fun remove(calendarId: Long, eventId: Long, marker: String)
}

class AndroidCalendarProvider(context: Context) : CalendarProvider {
    private val app = context.applicationContext
    private val resolver = app.contentResolver
    override fun hasPermission() = app.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED &&
        app.checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED
    private fun requirePermission() { if (!hasPermission()) throw SecurityException("Calendar permission required") }
    override fun calendars(): List<WritableCalendar> {
        requirePermission()
        val projection = arrayOf(Calendars._ID, Calendars.CALENDAR_DISPLAY_NAME, Calendars.ACCOUNT_NAME,
            Calendars.ACCOUNT_TYPE, Calendars.MAX_REMINDERS, Calendars.ALLOWED_REMINDERS)
        val cursor = resolver.query(Calendars.CONTENT_URI, projection, "${Calendars.CALENDAR_ACCESS_LEVEL} >= ?",
            arrayOf(Calendars.CAL_ACCESS_CONTRIBUTOR.toString()), "${Calendars.CALENDAR_DISPLAY_NAME} ASC")
            ?: throw IllegalStateException("Calendar provider is unavailable")
        return cursor.use { c -> buildList {
            while (c.moveToNext()) add(WritableCalendar(c.getLong(0), c.getString(1).orEmpty(), c.getString(2).orEmpty(),
                c.getString(3).orEmpty(), if (c.isNull(4)) 0 else c.getInt(4).coerceAtLeast(0),
                c.getString(5).orEmpty().split(',').mapNotNull { it.trim().toIntOrNull() }.toSet()))
        } }
    }
    override fun findOwned(calendarId: Long, marker: String): List<Long> {
        requirePermission()
        return resolver.query(Events.CONTENT_URI, arrayOf(Events._ID, Events.DESCRIPTION),
            "${Events.CALENDAR_ID} = ? AND ${Events.DELETED} = 0 AND ${Events.DESCRIPTION} LIKE ?",
            arrayOf(calendarId.toString(), "%$marker%"), null)?.use { c -> buildList {
                while(c.moveToNext()) if (owns(c.getString(1), marker)) add(c.getLong(0))
            } } ?: throw IllegalStateException("Calendar provider is unavailable")
    }
    override fun isOwned(calendarId: Long, eventId: Long, marker: String): Boolean {
        requirePermission()
        return resolver.query(ContentUris.withAppendedId(Events.CONTENT_URI, eventId), arrayOf(Events.CALENDAR_ID, Events.DESCRIPTION, Events.DELETED),
            null, null, null)?.use { c -> c.moveToFirst() && c.getLong(0) == calendarId && c.getInt(2) == 0 && owns(c.getString(1), marker) }
            ?: throw IllegalStateException("Calendar provider is unavailable")
    }
    private fun owns(description: String?, marker: String) = description.orEmpty().lineSequence().any { it == marker }
    override fun write(calendarId: Long, eventId: Long?, marker: String, event: CalendarWrite): Long {
        requirePermission()
        val values = ContentValues().apply {
            put(Events.CALENDAR_ID, calendarId); put(Events.TITLE, event.title)
            put(Events.DESCRIPTION, event.description + "\n" + marker); put(Events.EVENT_LOCATION, event.location)
            put(Events.DTSTART, event.occurrence.start); put(Events.DTEND, event.occurrence.end)
            put(Events.EVENT_TIMEZONE, event.occurrence.zone); put(Events.ALL_DAY, 0)
            put(Events.HAS_ALARM, if(event.reminders.isEmpty()) 0 else 1)
        }
        val operations = arrayListOf<ContentProviderOperation>()
        if (eventId == null) operations.add(ContentProviderOperation.newInsert(Events.CONTENT_URI).withValues(values).build())
        else {
            // Assert ownership in the same provider transaction before mutating the row/reminders.
            val description = ownedDescription(calendarId, eventId, marker)
            operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(Events.CONTENT_URI, eventId))
                .withSelection("${Events.CALENDAR_ID} = ? AND ${Events.DESCRIPTION} = ? AND ${Events.DELETED} = 0", arrayOf(calendarId.toString(), description))
                .withExpectedCount(1).build())
            operations.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(Events.CONTENT_URI, eventId)).withValues(values).withExpectedCount(1).build())
            operations.add(ContentProviderOperation.newDelete(Reminders.CONTENT_URI).withSelection("${Reminders.EVENT_ID} = ?", arrayOf(eventId.toString())).build())
        }
        event.reminders.forEach { minutes ->
            val operation = ContentProviderOperation.newInsert(Reminders.CONTENT_URI)
                .withValue(Reminders.MINUTES, minutes).withValue(Reminders.METHOD, Reminders.METHOD_ALERT)
            if(eventId == null) operation.withValueBackReference(Reminders.EVENT_ID, 0) else operation.withValue(Reminders.EVENT_ID, eventId)
            operations.add(operation.build())
        }
        val result = resolver.applyBatch(CalendarContract.AUTHORITY, operations)
        return eventId ?: ContentUris.parseId(result[0].uri ?: throw IllegalStateException("Provider returned no event ID"))
    }
    private fun ownedDescription(calendarId: Long, eventId: Long, marker: String): String {
        return resolver.query(ContentUris.withAppendedId(Events.CONTENT_URI, eventId), arrayOf(Events.CALENDAR_ID, Events.DESCRIPTION, Events.DELETED), null, null, null)?.use { c ->
            check(c.moveToFirst() && c.getLong(0) == calendarId && c.getInt(2) == 0 && owns(c.getString(1), marker)) { "Linked event was deleted, moved or ownership marker removed" }
            c.getString(1)
        } ?: throw IllegalStateException("Calendar provider is unavailable")
    }
    override fun remove(calendarId: Long, eventId: Long, marker: String) {
        requirePermission()
        val description = ownedDescription(calendarId, eventId, marker)
        // An exact ownership predicate makes a stale/reused ID harmless.
        val count = resolver.delete(Events.CONTENT_URI, "${Events._ID} = ? AND ${Events.CALENDAR_ID} = ? AND ${Events.DESCRIPTION} = ? AND ${Events.DELETED} = 0",
            arrayOf(eventId.toString(), calendarId.toString(), description))
        check(count == 1) { "Linked event changed before deletion" }
    }
}
