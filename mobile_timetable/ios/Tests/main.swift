// macOS: swiftc ios/Shared/TimetableData.swift ios/Tests/main.swift -o /tmp/bcorn-ios-tests && /tmp/bcorn-ios-tests
// Foundation model tests; these do not need Flutter, UIKit, WidgetKit or signing.
import Foundation

var checks = 0
func expect(_ condition: @autoclosure () -> Bool, _ description: String) {
    checks += 1
    guard condition() else { fatalError("FAILED: \(description)") }
}
var calendar = Calendar(identifier: .gregorian)
calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
func date(_ value: String) -> Date {
    let formatter = ISO8601DateFormatter()
    return formatter.date(from: value)!
}
func course(id: String = "math", weekday: Int = 1, start: Int = 540, end: Int = 630,
            first: String? = nil, last: String? = nil, map: String = "https://maps.apple.com/?q=School") -> TimetableCourse {
    TimetableCourse(id: id, title: "高等数学", weekday: weekday, startMinutes: start, endMinutes: end,
                    location: "A302", mapUrl: map, notes: "", color: 0xFF7566EF, startDate: first, endDate: last)
}
let monday = date("2026-10-12T09:00:00+08:00")
expect(TimetableCalendar.weekday(monday, calendar: calendar) == 1, "Monday is 1")
expect(TimetableCalendar.weekday(date("2026-10-18T09:00:00+08:00"), calendar: calendar) == 7, "Sunday is 7")
expect(TimetableCalendar.isValidDateKey("2024-02-29"), "Leap day")
expect(!TimetableCalendar.isValidDateKey("2026-02-29"), "Invalid leap day")
expect(!TimetableCalendar.isValidDateKey("2026-13-01"), "Invalid month")
expect(!TimetableCalendar.isValidDateKey("2026-2-01"), "Padded date")

let regular = course()
let now = TimetableCalendar.currentOrNext(at: monday, courses: [regular], calendar: calendar)!
expect(now.isCurrent(at: monday), "Inclusive start")
expect(!now.isCurrent(at: date("2026-10-12T10:30:00+08:00")), "Exclusive end")
let following = TimetableCalendar.currentOrNext(at: date("2026-10-12T10:30:00+08:00"), courses: [regular], calendar: calendar)!
expect(TimetableCalendar.dateKey(following.start, calendar: calendar) == "2026-10-19", "Next weekly class after end")
let semester = course(first: "2026-10-12", last: "2026-10-12")
expect(TimetableCalendar.occurrences(on: monday, courses: [semester], calendar: calendar).count == 1, "Inclusive semester dates")
expect(TimetableCalendar.currentOrNext(at: date("2026-10-12T10:30:00+08:00"), courses: [semester], calendar: calendar) == nil, "Expired semester")
let future = course(first: "2027-02-01", last: "2027-05-30")
expect(TimetableCalendar.dateKey(TimetableCalendar.currentOrNext(at: monday, courses: [future], calendar: calendar)!.start, calendar: calendar) == "2027-02-01", "Far-future semester")
let endingAtMidnight = course(start: 1380, end: 1440)
expect(TimetableCalendar.dateKey(TimetableCalendar.occurrences(on: monday, courses: [endingAtMidnight], calendar: calendar)[0].end, calendar: calendar) == "2026-10-13", "24:00 end is next midnight")
let overlaps = [course(id: "b", start: 540, end: 660), course(id: "a", start: 540, end: 630)]
expect(TimetableCalendar.currentOrNext(at: monday, courses: overlaps, calendar: calendar)?.course.id == "a", "Stable overlap ordering")

for bad in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,test", "intent://x", "https://user:password@example.com", "https://", "https://example.com/\nfoo"] {
    expect(SafeMapURL.parse(bad) == nil, "Reject unsafe URL: \(bad)")
}
for good in ["https://maps.apple.com/?q=School", "geo:0,0?q=School", "iosamap://path?dlat=31&dlon=121", "maps://?q=School", "google.navigation:q=School"] {
    expect(SafeMapURL.parse(good) != nil, "Accept map URL: \(good)")
}
for id in ["math-mon", "高等数学", "class/a?b#c", "a b", "percent%"] {
    let link = CourseWidgetURL.make(courseID: id)
    expect(CourseWidgetURL.courseID(from: link) == id, "Course detail link roundtrip: \(id)")
}
expect(CourseWidgetURL.courseID(from: URL(string: "bcorn://map?url=https://example.com")!) == nil, "No map redirect from a widget URL")
expect(CourseWidgetURL.courseID(from: URL(string: "bcorn://course/")!) == nil, "Empty course link rejected")
expect(CourseWidgetURL.courseID(from: URL(string: "https://course/math")!) == nil, "Foreign course scheme rejected")
let document = TimetableDocument(version: 1, updatedAt: "2026-10-15T05:00:00.000Z", courses: [regular])
let encoded = String(data: try JSONEncoder().encode(document), encoding: .utf8)!
let decoded = try TimetableDocument.decode(encoded)
expect(decoded.courses.count == 1, "JSON roundtrip")
do {
    try course(start: 630, end: 540).validate()
    fatalError("FAILED: Overnight class was accepted")
} catch { checks += 1 }
do {
    _ = try TimetableDocument.decode(encoded.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"))
    fatalError("FAILED: Unknown version was accepted")
} catch { checks += 1 }

var dstCalendar = Calendar(identifier: .gregorian)
dstCalendar.timeZone = TimeZone(identifier: "America/New_York")!
let springForward = date("2026-03-08T12:00:00-04:00")
let dstOccurrence = TimetableCalendar.occurrences(on: springForward, courses: [course(weekday: 7)], calendar: dstCalendar)[0]
expect(dstCalendar.component(.hour, from: dstOccurrence.start) == 9, "DST preserves wall-clock hours")
print("PASS: \(checks) timetable model checks")
