import Foundation

/// Add this file to BOTH the Runner and TimetableWidgets target memberships.
enum TimetableConfiguration {
    // Change this identifier in BOTH entitlements files when configuring your team.
    static let appGroup = "group.io.bcorn.mobile"
    static let storageKey = "timetable_json"
    static let widgetKind = "BcornTimetable"
    static let channelName = "io.bcorn.mobile/timetable"
    static let appURL = URL(string: "bcorn://timetable")!
}

enum TimetableDataError: LocalizedError {
    case invalid(String)
    case appGroupUnavailable

    var errorDescription: String? {
        switch self {
        case .invalid(let reason): return reason
        case .appGroupUnavailable:
            return "App Group is unavailable. Enable the same App Group for Runner and TimetableWidgets in Xcode."
        }
    }
}

struct TimetableDocument: Codable {
    let version: Int
    let updatedAt: String
    let courses: [TimetableCourse]

    static func decode(_ json: String) throws -> TimetableDocument {
        guard let data = json.data(using: .utf8), data.count <= 1_000_000 else {
            throw TimetableDataError.invalid("Timetable must be UTF-8 JSON smaller than 1 MB.")
        }
        let document = try JSONDecoder().decode(TimetableDocument.self, from: data)
        guard document.version == 1 else {
            throw TimetableDataError.invalid("Unsupported timetable version.")
        }
        guard document.courses.count <= 500 else {
            throw TimetableDataError.invalid("At most 500 courses are supported.")
        }
        let timestamp = ISO8601DateFormatter()
        timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractionalDate = timestamp.date(from: document.updatedAt)
        timestamp.formatOptions = [.withInternetDateTime]
        guard fractionalDate != nil || timestamp.date(from: document.updatedAt) != nil else {
            throw TimetableDataError.invalid("updatedAt must be an ISO-8601 timestamp.")
        }
        var identifiers = Set<String>()
        for course in document.courses {
            try course.validate()
            guard identifiers.insert(course.id).inserted else {
                throw TimetableDataError.invalid("Course IDs must be unique.")
            }
        }
        return document
    }
}

struct TimetableCourse: Codable, Identifiable {
    let id: String
    let title: String
    let weekday: Int // ISO weekday: Monday = 1, Sunday = 7.
    let startMinutes: Int
    let endMinutes: Int
    let location: String
    let mapUrl: String
    let notes: String
    let color: Int64 // Unsigned 32-bit ARGB transported as a JSON integer.
    let startDate: String?
    let endDate: String?

    func validate() throws {
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (1...7).contains(weekday),
              (0...1439).contains(startMinutes),
              (1...1440).contains(endMinutes),
              endMinutes > startMinutes,
              (0...0xFFFF_FFFF).contains(color) else {
            throw TimetableDataError.invalid("Invalid course ID, title, weekday, time range or ARGB color.")
        }
        guard id.count <= 128, title.count <= 120, location.count <= 500,
              notes.count <= 4000, mapUrl.count <= 4000 else {
            throw TimetableDataError.invalid("Course content exceeds the shared contract limits.")
        }
        for value in [startDate, endDate].compactMap({ $0 }) {
            guard TimetableCalendar.isValidDateKey(value) else {
                throw TimetableDataError.invalid("Course dates must be real YYYY-MM-DD dates.")
            }
        }
        if let first = startDate, let last = endDate, first > last {
            throw TimetableDataError.invalid("Course startDate must not be after endDate.")
        }
        if !mapUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           SafeMapURL.parse(mapUrl) == nil {
            throw TimetableDataError.invalid("Course map link uses an unsupported or invalid URL.")
        }
    }

    var timeLabel: String {
        "\(Self.clock(startMinutes))–\(Self.clock(endMinutes))"
    }

    private static func clock(_ minutes: Int) -> String {
        String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }
}

enum SafeMapURL {
    static let allowedSchemes: Set<String> = [
        "http", "https", "geo", "google.navigation", "amapuri", "iosamap", "androidamap", "maps"
    ]

    static func parse(_ raw: String) -> URL? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 4096,
              value.rangeOfCharacter(from: .controlCharacters) == nil,
              let parts = URLComponents(string: value),
              let scheme = parts.scheme?.lowercased(), allowedSchemes.contains(scheme),
              parts.user == nil, parts.password == nil,
              let url = parts.url else { return nil }
        if scheme == "http" || scheme == "https" {
            guard let host = parts.host, !host.isEmpty else { return nil }
        }
        return url
    }
}

/// Course taps only navigate to details. Map opening is a separate app action.
enum CourseWidgetURL {
    static func make(courseID: String) -> URL {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let encoded = courseID.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return URL(string: "bcorn://course/\(encoded)") ?? TimetableConfiguration.appURL
    }

    static func courseID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "bcorn", url.host == "course",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let encodedPath = parts.percentEncodedPath
        guard encodedPath.hasPrefix("/") else { return nil }
        let component = String(encodedPath.dropFirst())
        guard !component.isEmpty, !component.contains("/"),
              let decoded = component.removingPercentEncoding, !decoded.isEmpty else { return nil }
        return decoded
    }
}

enum TimetableStore {
    static func defaults() throws -> UserDefaults {
        guard FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: TimetableConfiguration.appGroup
        ) != nil, let defaults = UserDefaults(suiteName: TimetableConfiguration.appGroup) else {
            throw TimetableDataError.appGroupUnavailable
        }
        return defaults
    }

    static func loadJSON() throws -> String? {
        try defaults().string(forKey: TimetableConfiguration.storageKey)
    }

    static func load() throws -> TimetableDocument? {
        guard let json = try loadJSON() else { return nil }
        return try TimetableDocument.decode(json)
    }

    static func saveJSON(_ json: String) throws {
        _ = try TimetableDocument.decode(json)
        try defaults().set(json, forKey: TimetableConfiguration.storageKey)
    }
}

struct CourseOccurrence: Identifiable {
    let course: TimetableCourse
    let start: Date
    let end: Date
    var id: String { "\(course.id):\(start.timeIntervalSince1970)" }
    func isCurrent(at date: Date) -> Bool { start <= date && date < end }
}

enum TimetableCalendar {
    /// A Gregorian calendar in the device's current timezone, regardless of the
    /// user's preferred display calendar. Course date strings are Gregorian.
    static var local: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .autoupdatingCurrent
        return calendar
    }

    static func isValidDateKey(_ value: String) -> Bool {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return false }
        let pieces = value.split(separator: "-").compactMap { Int($0) }
        guard pieces.count == 3, pieces[0] >= 1 else { return false }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let date = utc.date(from: DateComponents(year: pieces[0], month: pieces[1], day: pieces[2])) else { return false }
        let back = utc.dateComponents([.year, .month, .day], from: date)
        return back.year == pieces[0] && back.month == pieces[1] && back.day == pieces[2]
    }

    static func dateKey(_ date: Date, calendar: Calendar = local) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    static func weekday(_ date: Date, calendar: Calendar = local) -> Int {
        (calendar.component(.weekday, from: date) + 5) % 7 + 1
    }

    static func occurrences(on date: Date, courses: [TimetableCourse], calendar: Calendar = local) -> [CourseOccurrence] {
        let day = calendar.startOfDay(for: date)
        let key = dateKey(day, calendar: calendar)
        let isoWeekday = weekday(day, calendar: calendar)
        return courses.compactMap { course -> CourseOccurrence? in
            guard course.weekday == isoWeekday,
                  course.startDate.map({ key >= $0 }) ?? true,
                  course.endDate.map({ key <= $0 }) ?? true,
                  let start = wallTime(minutes: course.startMinutes, on: day, calendar: calendar),
                  let end = wallTime(minutes: course.endMinutes, on: day, calendar: calendar),
                  end > start else { return nil }
            return CourseOccurrence(course: course, start: start, end: end)
        }.sorted { left, right in
            if left.start != right.start { return left.start < right.start }
            if left.end != right.end { return left.end < right.end }
            return left.course.id < right.course.id
        }
    }

    /// Wall-clock times, not elapsed seconds since midnight, preserve schedules
    /// on DST days. A missing local time moves forward; repeated times use first.
    static func wallTime(minutes: Int, on day: Date, calendar: Calendar = local) -> Date? {
        if minutes == 1440 { return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: day)) }
        return calendar.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0,
                             of: day, matchingPolicy: .nextTime,
                             repeatedTimePolicy: .first, direction: .forward)
    }

    /// Find a current class first; otherwise choose the earliest future class.
    /// Searching from each course's semester start avoids a finite lookahead
    /// accidentally hiding a course that begins in a later semester.
    static func currentOrNext(at now: Date, courses: [TimetableCourse], calendar: Calendar = local) -> CourseOccurrence? {
        let today = calendar.startOfDay(for: now)
        let todayKey = dateKey(today, calendar: calendar)
        var candidates: [CourseOccurrence] = []
        for course in courses {
            var anchor = today
            if let first = course.startDate, first > todayKey,
               let parsed = dayFromKey(first, calendar: calendar) { anchor = parsed }
            let firstOffset = (course.weekday - weekday(anchor, calendar: calendar) + 7) % 7
            // Weekly recurrence needs at most the nearest matching day and the
            // following week, avoiding a seven-day scan for every timeline entry.
            for offset in [firstOffset, firstOffset + 7] {
                guard let day = calendar.date(byAdding: .day, value: offset, to: anchor) else { continue }
                if let occurrence = occurrences(on: day, courses: [course], calendar: calendar).first,
                   occurrence.end > now {
                    candidates.append(occurrence)
                    break
                }
            }
        }
        return candidates.sorted { left, right in
            let leftCurrent = left.isCurrent(at: now)
            let rightCurrent = right.isCurrent(at: now)
            if leftCurrent != rightCurrent { return leftCurrent }
            if left.start != right.start { return left.start < right.start }
            if left.end != right.end { return left.end < right.end }
            return left.course.id < right.course.id
        }.first
    }

    static func dayFromKey(_ key: String, calendar: Calendar = local) -> Date? {
        let pieces = key.split(separator: "-").compactMap { Int($0) }
        guard pieces.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: pieces[0], month: pieces[1], day: pieces[2]))
    }
}
