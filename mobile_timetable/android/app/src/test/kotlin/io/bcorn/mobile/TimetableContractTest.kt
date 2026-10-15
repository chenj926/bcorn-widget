package io.bcorn.mobile

import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime

/** Local JVM tests for the actual native parser and recurrence/boundary model. */
class TimetableContractTest {
    private fun json(courses: String): String = """{"version":1,"updatedAt":"2026-10-15T05:00:00Z","courses":[$courses]}"""
    private fun row(
        id: String = "math",
        day: Int = 4,
        start: Int = 540,
        end: Int = 630,
        startDate: String = "null",
        endDate: String = "null",
    ): String = """{"id":"$id","title":"高等数学","weekday":$day,"startMinutes":$start,"endMinutes":$end,"location":"教学楼","mapUrl":"","notes":"","color":4282948208,"startDate":$startDate,"endDate":$endDate}"""

    @Test fun emptySnapshotDoesNotInsertDemoCourses() {
        assertTrue(TimetableStore.parse(json("")).isEmpty())
    }

    @Test fun startsInclusiveAndEndsExclusive() {
        val course = TimetableStore.parse(json(row())).single()
        assertFalse(course.isCurrent(539))
        assertTrue(course.isCurrent(540))
        assertTrue(course.isCurrent(629))
        assertFalse(course.isCurrent(630))
    }

    @Test fun dateBoundsAreInclusiveAndWeekdayIsLocal() {
        val course = TimetableStore.parse(json(row(startDate = "\"2026-10-15\"", endDate = "\"2026-10-22\""))).single()
        assertTrue(course.occursOn(LocalDate.of(2026, 10, 15)))
        assertTrue(course.occursOn(LocalDate.of(2026, 10, 22)))
        assertFalse(course.occursOn(LocalDate.of(2026, 10, 8)))
        assertFalse(course.occursOn(LocalDate.of(2026, 10, 29)))
        assertFalse(course.occursOn(LocalDate.of(2026, 10, 16)))
    }

    @Test fun preservesOverlapsAndSortsToday() {
        val courses = TimetableStore.parse(json(listOf(row("b", start = 600, end = 700), row("a"), row("friday", day = 5)).joinToString(",")))
        val today = TimetableSnapshot(courses, true).today(LocalDateTime.of(2026, 10, 15, 10, 10))
        assertEquals(listOf("a", "b"), today.map { it.id })
        assertEquals(2, today.count { it.isCurrent(610) })
    }

    @Test fun midnightEndIsValidAndFormatsAs2400() {
        val course = TimetableStore.parse(json(row(start = 1380, end = 1440))).single()
        assertTrue(course.isCurrent(1439))
        assertEquals("24:00", formatMinutes(course.endMinutes))
    }

    @Test(expected = IllegalArgumentException::class)
    fun duplicateIdsRejectWholeSnapshot() { TimetableStore.parse(json("${row()},${row()}")) }

    @Test(expected = IllegalArgumentException::class)
    fun overnightCourseIsRejected() { TimetableStore.parse(json(row(start = 1380, end = 60))) }

    @Test(expected = IllegalArgumentException::class)
    fun weekdayZeroIsRejected() { TimetableStore.parse(json(row(day = 0))) }

    @Test(expected = IllegalArgumentException::class)
    fun reversedDateRangeIsRejected() {
        TimetableStore.parse(json(row(startDate = "\"2026-10-22\"", endDate = "\"2026-10-15\"")))
    }

    @Test(expected = IllegalArgumentException::class)
    fun unsupportedVersionIsRejected() {
        TimetableStore.parse("""{"version":2,"courses":[]}""")
    }
}
