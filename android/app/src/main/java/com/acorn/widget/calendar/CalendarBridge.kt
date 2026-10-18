package com.acorn.widget.calendar

import android.content.Context
import android.content.SharedPreferences
import android.provider.CalendarContract.Reminders
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/**
 * A small, synchronous local-first facade. Call from a serial worker, then deliver the result on UI.
 * Binding journal is PRIVATE app state, never part of exported/imported course JSON.
 * A selected provider target is the sole writer; cloud adapters must not also write these events.
 */
class CalendarBridge @JvmOverloads constructor(context: Context,
    private val provider: CalendarProvider = AndroidCalendarProvider(context)) {
    private val preferences: SharedPreferences = context.applicationContext.getSharedPreferences("calendar-links-v1", Context.MODE_PRIVATE)

    @Synchronized fun call(method: String, args: JSONObject): JSONObject {
        return try {
            when (method) {
                "calendarStatus" -> success().put("permissionGranted", provider.hasPermission())
                    .put("selectedCalendarId", preferences.getLong("selected", -1)).put("route", "android-provider")
                "listCalendars" -> {
                    permission()
                    success().put("calendars", JSONArray().apply { provider.calendars().forEach { c -> put(JSONObject()
                        .put("id", c.id).put("name", c.name).put("account", c.account).put("accountType", c.accountType)
                        .put("maxReminders", c.maxReminders).put("supportsAlerts", Reminders.METHOD_ALERT in c.reminderMethods)) } })
                }
                "selectCalendar" -> {
                    permission()
                    val target = provider.calendars().singleOrNull { it.id == args.getLong("calendarId") }
                        ?: throw CalendarFailure("calendarUnavailable", "Choose a currently writable calendar")
                    val otherBindings = preferences.all.entries.any { (key, raw) ->
                        if (!key.startsWith("event-") || raw !is String) false
                        else JSONObject(raw).let { journal -> journal.optJSONObject("links")?.length()?.let { it > 0 } == true && journal.optString("identity") != target.identity }
                    }
                    if (otherBindings) throw CalendarFailure("targetChanged", "Remove existing linked events before selecting another calendar")
                    save(preferences.edit().putLong("selected", target.id).putString("identity", target.identity))
                    success().put("calendarId", target.id)
                }
                "syncCalendarEvent" -> sync(args)
                "removeCalendarEvent" -> remove(args)
                else -> throw CalendarFailure("unsupported", "Unknown calendar operation")
            }
        } catch (error: SecurityException) {
            failure("permissionRequired", "Allow calendar access to enable linked updates. Manual export remains available.")
        } catch (error: CalendarFailure) { failure(error.code, error.message.orEmpty())
        } catch (error: IllegalArgumentException) { failure("invalidEvent", error.message.orEmpty())
        } catch (error: org.json.JSONException) { failure("invalidEvent", error.message.orEmpty())
        } catch (error: java.time.DateTimeException) { failure("invalidEvent", error.message.orEmpty())
        } catch (error: Exception) { failure("providerError", error.message ?: "Calendar write failed; retry after checking the selected calendar") }
    }
    private fun permission() { if(!provider.hasPermission()) throw SecurityException() }
    private fun selected(): WritableCalendar {
        permission()
        val calendar = provider.calendars().singleOrNull { it.id == preferences.getLong("selected", -1) }
            ?: throw CalendarFailure("calendarRequired", "Select a writable device calendar first")
        if (calendar.identity != preferences.getString("identity", null)) throw CalendarFailure("calendarChanged", "The calendar account changed; select it again")
        return calendar
    }
    private fun eventId(args: JSONObject): String = args.getString("id").also { require(it.isNotBlank() && it.length <= 512) { "Stable local id required" } }
    private fun key(id: String) = "event-" + hash(id)
    private fun load(id: String): JSONObject = preferences.getString(key(id), null)?.let { JSONObject(it) } ?: JSONObject().put("links", JSONObject())
    private fun persist(id: String, journal: JSONObject) { save(preferences.edit().putString(key(id), journal.toString())) }
    private fun save(editor: SharedPreferences.Editor) { check(editor.commit()) { "Could not persist calendar link; stop and retry" } }
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun sync(input: JSONObject): JSONObject {
        val calendar = selected()
        val id = eventId(input)
        val title = input.getString("title").trim()
        require(title.isNotEmpty() && title.length <= 1024) { "Event title required (maximum 1024 characters)" }
        val description = input.optString("description", "")
        val location = input.optString("location", "")
        require(description.length <= 32000 && location.length <= 2048) { "Event text is too long" }
        val occurrences = CalendarOccurrences.expand(input)
        val reminders = input.optJSONArray("reminders")?.let { a -> (0 until a.length()).map {
            val value = a.get(it)
            require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toInt().toDouble()) { "Reminder minutes must be integers" }
            value.toInt()
        }.distinct().sorted() } ?: emptyList()
        require(reminders.all { it in 0..40320 }) { "Reminder must be 0–40320 minutes before the event" }
        if(reminders.size > calendar.maxReminders || (reminders.isNotEmpty() && Reminders.METHOD_ALERT !in calendar.reminderMethods))
            throw CalendarFailure("unsupportedReminders", "Selected calendar does not support these alert reminders (maximum ${calendar.maxReminders})")
        val journal = load(id)
        if (journal.has("identity") && journal.getString("identity") != calendar.identity)
            throw CalendarFailure("targetChanged", "This event is linked to another calendar. Remove that link explicitly before moving it.")
        journal.put("identity", calendar.identity).put("calendarId", calendar.id)
        val links = journal.getJSONObject("links")
        var written = 0
        var unchanged = 0
        // Journal all markers with one disk commit BEFORE touching the provider. A failed series
        // recovers by marker, without an fsync per occurrence or a background retry loop.
        for (occurrence in occurrences) if (!links.has(occurrence.key)) {
            links.put(occurrence.key, JSONObject().put("marker", "[bcorn-link:${UUID.randomUUID()}]"))
        }
        persist(id, journal)
        for (occurrence in occurrences) {
            val link = links.getJSONObject(occurrence.key)
            val marker = link.getString("marker")
            var remoteId: Long? = if(link.has("remoteId")) link.getLong("remoteId") else null
            if(remoteId != null && !provider.isOwned(calendar.id, remoteId, marker))
                throw CalendarFailure("linkConflict", "Linked event was deleted, moved or its ownership marker removed. Nothing unrelated was changed.")
            if(remoteId == null) {
                val recovered = provider.findOwned(calendar.id, marker)
                if(recovered.size > 1) throw CalendarFailure("linkConflict", "Multiple events have this link; resolve duplicate events before retrying")
                remoteId = recovered.singleOrNull()
            }
            val signature = hash(JSONArray().put(title).put(description).put(location).put(occurrence.start).put(occurrence.end).put(occurrence.zone).put(JSONArray(reminders)).toString())
            if(remoteId != null && link.optString("signature") == signature) { unchanged++; continue }
            val result = provider.write(calendar.id, remoteId, marker, CalendarWrite(title, description, location, occurrence, reminders))
            link.put("remoteId", result).put("signature", signature)
            written++
        }
        // Reconcile only this local series' previously linked occurrences. Never sweep a calendar.
        val desired = occurrences.map { it.key }.toSet()
        val stale = links.keys().asSequence().filter { it !in desired }.toList()
        var removed = 0
        stale.forEach { occurrenceKey -> removed += deleteLink(calendar.id, links.getJSONObject(occurrenceKey)); links.remove(occurrenceKey) }
        persist(id, journal)
        return success().put("written", written).put("unchanged", unchanged).put("removed", removed).put("unlinked", stale.size)
            .put("occurrences", occurrences.size).put("calendarId", calendar.id).put("route", "android-provider")
    }
    private fun deleteLink(calendarId: Long, link: JSONObject): Int {
        val marker = link.getString("marker")
        // Marker search also recovers an insert interrupted before saving its returned ID.
        val owned = provider.findOwned(calendarId, marker)
        if(owned.size > 1) throw CalendarFailure("linkConflict", "Multiple events have this ownership marker")
        if(link.has("remoteId") && owned.isNotEmpty() && owned.single() != link.getLong("remoteId"))
            throw CalendarFailure("linkConflict", "Linked event identity changed")
        owned.singleOrNull()?.let { provider.remove(calendarId, it, marker) }
        // Missing marker/deleted row: drop local link only; do not delete any guessed/reused ID.
        return owned.size
    }
    private fun remove(input: JSONObject): JSONObject {
        permission()
        val id = eventId(input)
        val journal = load(id)
        if(!journal.has("calendarId")) return success().put("removed", 0)
        val target = provider.calendars().singleOrNull { it.identity == journal.getString("identity") }
            ?: throw CalendarFailure("calendarUnavailable", "Original calendar unavailable; linked events have not been removed")
        val links = journal.getJSONObject("links")
        val keys = links.keys().asSequence().toList()
        var removed = 0
        keys.forEach { removed += deleteLink(target.id, links.getJSONObject(it)); links.remove(it) }
        save(preferences.edit().remove(key(id)))
        return success().put("removed", removed).put("unlinked", keys.size)
    }
    private fun success() = JSONObject().put("ok", true)
    private fun failure(code: String, message: String) = JSONObject().put("ok", false).put("code", code).put("message", message)
        .put("localDataPreserved", true).put("retryMayBeNeeded", true)
    private class CalendarFailure(val code: String, message: String): Exception(message)
}
