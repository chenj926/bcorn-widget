package com.acorn.widget.calendar

import org.json.JSONObject
import java.time.*

/** Bounded wall-clock expansion keeps semester courses correct across DST and exceptions. */
data class CalendarOccurrence(val key: String, val start: Long, val end: Long, val zone: String)

object CalendarOccurrences {
    @JvmStatic fun expand(input: JSONObject): List<CalendarOccurrence> {
        val zone = ZoneId.of(input.getString("timeZone"))
        // The shared CourseTools adapter may provide its canonical, already-expanded instants.
        // Date keys remain stable when an occurrence's start time changes.
        input.optJSONArray("occurrences")?.let { values ->
            require(values.length() <= 1000) { "At most 1000 occurrences per meeting" }
            val keys = mutableSetOf<String>()
            return (0 until values.length()).map { index ->
                val item = values.getJSONObject(index)
                val key = item.getString("key")
                LocalDate.parse(key)
                require(keys.add(key)) { "Duplicate occurrence date key" }
                fun millis(field: String): Long {
                    val value = item.get(field)
                    require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble()) { "Occurrence times must be integer milliseconds" }
                    return value.toLong().also { require(it in -2208988800000L..253370764800000L) { "Occurrence date is out of range" } }
                }
                val start = millis("startMillis")
                val end = millis("endMillis")
                require(end > start && end - start <= 7 * 86400000L) { "Event duration must be positive and at most seven days" }
                CalendarOccurrence(key, start, end, zone.id)
            }
        }
        val recurrence = input.optJSONObject("recurrence")
        if (recurrence == null) {
            val start = LocalDateTime.parse(input.getString("start"))
            val end = LocalDateTime.parse(input.getString("end"))
            return listOf(occurrence("once", start, end, zone))
        }
        val first = LocalDate.parse(recurrence.getString("startDate"))
        val last = LocalDate.parse(recurrence.getString("endDate"))
        require(!last.isBefore(first) && java.time.temporal.ChronoUnit.DAYS.between(first, last) <= 730) { "Course date range must be 0–730 days" }
        val weekdays = recurrence.getJSONArray("weekdays").let { a -> (0 until a.length()).map { a.getInt(it) }.toSet() }
        require(weekdays.isNotEmpty() && weekdays.all { it in 1..7 }) { "weekdays must contain ISO days 1–7" }
        val exclusions = recurrence.optJSONArray("excludedDates")?.let { a -> (0 until a.length()).map { LocalDate.parse(a.getString(it)) }.toSet() } ?: emptySet()
        val startTime = LocalTime.parse(recurrence.getString("startTime"))
        val endTime = LocalTime.parse(recurrence.getString("endTime"))
        require(startTime != endTime) { "Course duration must be positive" }
        val result = mutableListOf<CalendarOccurrence>()
        var date = first
        while (!date.isAfter(last)) {
            if (date.dayOfWeek.value in weekdays && date !in exclusions) {
                val start = date.atTime(startTime)
                val end = (if (endTime < startTime) date.plusDays(1) else date).atTime(endTime)
                // Nonexistent DST wall times are excluded, not silently moved an hour.
                if (zone.rules.getValidOffsets(start).isNotEmpty() && zone.rules.getValidOffsets(end).isNotEmpty()) {
                    result.add(occurrence(date.toString(), start, end, zone))
                }
            }
            date = date.plusDays(1)
        }
        return result
    }

    private fun occurrence(key: String, start: LocalDateTime, end: LocalDateTime, zone: ZoneId): CalendarOccurrence {
        require(zone.rules.getValidOffsets(start).isNotEmpty() && zone.rules.getValidOffsets(end).isNotEmpty()) { "Time does not exist in this time zone (DST gap)" }
        // During the autumn overlap select the earlier offset deterministically.
        val from = start.atZone(zone).withEarlierOffsetAtOverlap().toInstant().toEpochMilli()
        val to = end.atZone(zone).withEarlierOffsetAtOverlap().toInstant().toEpochMilli()
        require(to > from && to - from <= 7 * 86400000L) { "Event duration must be positive and at most seven days" }
        return CalendarOccurrence(key, from, to, zone.id)
    }
}
