import SwiftUI
import WidgetKit

struct TimetableEntry: TimelineEntry {
    let date: Date
    let next: CourseOccurrence?
    let today: [CourseOccurrence]
    let hasCourses: Bool
    let errorMessage: String?

    var status: String { next?.isCurrent(at: date) == true ? "正在上课" : "下一节" }

    static func make(date: Date, document: TimetableDocument?, error: String? = nil) -> TimetableEntry {
        let courses = document?.courses ?? []
        return TimetableEntry(
            date: date,
            next: TimetableCalendar.currentOrNext(at: date, courses: courses),
            today: TimetableCalendar.occurrences(on: date, courses: courses),
            hasCourses: !courses.isEmpty,
            errorMessage: error
        )
    }
}

struct TimetableProvider: TimelineProvider {
    func placeholder(in context: Context) -> TimetableEntry { Self.sample(at: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (TimetableEntry) -> Void) {
        if context.isPreview { completion(Self.sample(at: Date())); return }
        let state = readState()
        completion(.make(date: Date(), document: state.document, error: state.error))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TimetableEntry>) -> Void) {
        let now = Date()
        let calendar = TimetableCalendar.local
        let today = calendar.startOfDay(for: now)
        let state = readState()
        let courses = state.document?.courses ?? []
        let horizon = calendar.date(byAdding: .day, value: 2, to: today)!
        var boundaries: Set<Date> = [now]
        for offset in 0...2 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: today) else { continue }
            if day > now { boundaries.insert(day) }
            guard offset < 2 else { continue }
            for occurrence in TimetableCalendar.occurrences(on: day, courses: courses) {
                if occurrence.start > now { boundaries.insert(occurrence.start) }
                if occurrence.end > now { boundaries.insert(occurrence.end) }
            }
        }
        let dates = boundaries.filter { $0 <= horizon }.sorted()
        // Bound memory when an imported timetable contains many overlapping classes.
        let entries = dates.prefix(128).map {
            TimetableEntry.make(date: $0, document: state.document, error: state.error)
        }
        let policy: TimelineReloadPolicy = dates.count > 128 ? .atEnd : .after(horizon)
        completion(Timeline(entries: entries, policy: policy))
    }

    private func readState() -> (document: TimetableDocument?, error: String?) {
        do { return (try TimetableStore.load(), nil) }
        catch TimetableDataError.appGroupUnavailable { return (nil, "请检查 App Groups 配置") }
        catch { return (nil, "课程数据无法读取，请打开 App") }
    }

    private static func sample(at now: Date) -> TimetableEntry {
        let calendar = TimetableCalendar.local
        let start = calendar.date(byAdding: .minute, value: 20, to: now)!
        let end = calendar.date(byAdding: .minute, value: 110, to: now)!
        let course = TimetableCourse(
            id: "preview", title: "高等数学", weekday: TimetableCalendar.weekday(now),
            startMinutes: 540, endMinutes: 630, location: "教学楼 A · 302", mapUrl: "",
            notes: "", color: 0xFF7566EF, startDate: nil, endDate: nil
        )
        let occurrence = CourseOccurrence(course: course, start: start, end: end)
        return TimetableEntry(date: now, next: occurrence, today: [occurrence], hasCourses: true, errorMessage: nil)
    }
}

@main
struct BcornTimetableWidget: Widget {
    let kind = TimetableConfiguration.widgetKind

    private var families: [WidgetFamily] {
        if #available(iOS 16.0, *) { return [.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular] }
        return [.systemSmall, .systemMedium, .systemLarge]
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TimetableProvider()) { entry in
            TimetableWidgetView(entry: entry)
        }
        .configurationDisplayName("课程表")
        .description("查看正在进行或即将开始的课程，也可在大号组件中查看今天的课程。")
        .supportedFamilies(families)
    }
}

struct TimetableWidgetView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme
    let entry: TimetableEntry
    private let accent = Color(red: 0.43, green: 0.36, blue: 0.86)

    var body: some View {
        Group {
            if #available(iOS 16.0, *), family == .accessoryRectangular {
                lockScreen
            } else {
                homeScreen
            }
        }
        .widgetURL(entry.next.map { CourseWidgetURL.make(courseID: $0.course.id) } ?? TimetableConfiguration.appURL)
        .timetablePrivacySensitive()
        .timetableContainerBackground(colorScheme == .dark ? Color(red: 0.10, green: 0.11, blue: 0.17) : Color(red: 0.97, green: 0.96, blue: 1))
    }

    private var homeScreen: some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 12 : 8) {
            HStack {
                Label("课程表", systemImage: "calendar")
                    .font(.system(size: 12, weight: .bold)).foregroundColor(accent)
                Spacer(minLength: 4)
                Text(shortDay(entry.date)).font(.system(size: 11)).foregroundColor(.secondary)
            }
            if let occurrence = entry.next {
                if family == .systemMedium { mediumCourse(occurrence) }
                else { primaryCourse(occurrence) }
            } else {
                emptyState
            }
            if family == .systemLarge { dayList }
            else { Spacer(minLength: 0) }
        }
        .padding(legacyContentPadding)
    }

    private func primaryCourse(_ occurrence: CourseOccurrence) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.status).font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
            Text(occurrence.course.title)
                .font(.system(size: family == .systemLarge ? 22 : 19, weight: .bold))
                .lineLimit(family == .systemSmall ? 2 : 1).minimumScaleFactor(0.8)
            Text(occurrenceTime(occurrence))
                .font(.system(size: 12, weight: .semibold)).foregroundColor(accent).lineLimit(1)
            Text(occurrence.course.location.isEmpty ? "地点待定" : occurrence.course.location)
                .font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
        }
    }

    private func mediumCourse(_ occurrence: CourseOccurrence) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Text(entry.status).font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
                Text(occurrence.course.title).font(.system(size: 21, weight: .bold)).lineLimit(2).minimumScaleFactor(0.8)
                Text(occurrence.course.location.isEmpty ? "地点待定" : occurrence.course.location)
                    .font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 6) {
                Text(occurrence.start, style: .time).font(.system(size: 23, weight: .bold, design: .rounded)).foregroundColor(accent)
                Text(relativeDay(occurrence.start)).font(.system(size: 11)).foregroundColor(.secondary)
                Link(destination: CourseWidgetURL.make(courseID: occurrence.course.id)) {
                    Label("查看课程", systemImage: "arrow.up.right").font(.system(size: 11, weight: .semibold))
                }.foregroundColor(accent)
            }
        }
    }

    private var legacyContentPadding: CGFloat {
        // iOS 17+ supplies adaptive widgetContentMargins. Do not double-inset.
        if #available(iOS 17.0, *) { return 0 }
        return 14
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 7) {
            Image(systemName: entry.errorMessage == nil ? "sun.max" : "exclamationmark.circle")
                .font(.system(size: 23)).foregroundColor(accent)
            Text(entry.errorMessage ?? (entry.hasCourses ? "暂无后续课程" : "准备好新的一天"))
                .font(.system(size: 16, weight: .semibold)).lineLimit(2)
            Text(entry.errorMessage == nil ? "打开 App，编辑你的课程表" : "打开 App 以检查配置或重新保存")
                .font(.system(size: 11)).foregroundColor(.secondary).lineLimit(2)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var dayList: some View {
        VStack(alignment: .leading, spacing: 7) {
            Divider()
            HStack {
                Text("今日安排").font(.system(size: 11, weight: .bold))
                Spacer()
                Text("\(entry.today.count) 节").font(.system(size: 10)).foregroundColor(.secondary)
            }
            if entry.today.isEmpty {
                Text("今天没有课程，好好享受空闲时间。")
                    .font(.system(size: 12)).foregroundColor(.secondary).padding(.top, 8)
            } else {
                ForEach(Array(entry.today.prefix(5))) { occurrence in
                    Link(destination: CourseWidgetURL.make(courseID: occurrence.course.id)) { dayRow(occurrence) }
                }
                if entry.today.count > 5 {
                    Text("还有 \(entry.today.count - 5) 节，打开 App 查看全部")
                        .font(.system(size: 10)).foregroundColor(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func dayRow(_ occurrence: CourseOccurrence) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(courseColor(occurrence.course)).frame(width: 3, height: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(occurrence.course.title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(occurrence.course.location.isEmpty ? "地点待定" : occurrence.course.location)
                    .font(.system(size: 10)).foregroundColor(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(occurrence.course.timeLabel).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary)
            Image(systemName: "chevron.right").font(.system(size: 9)).foregroundColor(accent)
        }
        .foregroundColor(.primary)
        .opacity(occurrence.end <= entry.date ? 0.5 : 1)
        .accessibilityElement(children: .combine)
    }

    private var lockScreen: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let occurrence = entry.next {
                Text("\(entry.status) · \(relativeDay(occurrence.start))").font(.caption2).lineLimit(1)
                Text(occurrence.course.title).font(.headline).lineLimit(1)
                Text("\(occurrence.course.timeLabel)  \(occurrence.course.location)").font(.caption2).lineLimit(1)
            } else {
                Label("课程表", systemImage: "calendar").font(.headline)
                Text(entry.errorMessage ?? (entry.hasCourses ? "暂无后续课程" : "打开 App 添加课程"))
                    .font(.caption2).lineLimit(2)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func courseColor(_ course: TimetableCourse) -> Color {
        let value = UInt64(course.color)
        return Color(red: Double((value >> 16) & 255) / 255,
                     green: Double((value >> 8) & 255) / 255,
                     blue: Double(value & 255) / 255)
    }

    private func shortDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日 EEE"
        return formatter.string(from: date)
    }

    private func relativeDay(_ date: Date) -> String {
        let calendar = TimetableCalendar.local
        if calendar.isDate(date, inSameDayAs: entry.date) { return "今天" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: entry.date), calendar.isDate(date, inSameDayAs: tomorrow) { return "明天" }
        return shortDay(date)
    }

    private func occurrenceTime(_ occurrence: CourseOccurrence) -> String {
        "\(relativeDay(occurrence.start)) · \(occurrence.course.timeLabel)"
    }
}

private extension View {
    @ViewBuilder
    func timetableContainerBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) { self.containerBackground(for: .widget) { color } }
        else { self.background(color) }
    }

    @ViewBuilder
    func timetablePrivacySensitive() -> some View {
        if #available(iOS 15.0, *) { self.privacySensitive() }
        else { self }
    }
}
