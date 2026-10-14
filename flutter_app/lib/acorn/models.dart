// 小组件用到的全部数据。都能转成 JSON，用来做本地缓存。

String ymd(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

int clockToMinutes(String hhmm) {
  final parts = hhmm.split(':');
  return int.parse(parts[0]) * 60 + int.parse(parts[1]);
}

/// 每周固定时间的一节课（来自 ACORN 的 iCal 导出）。
class Meeting {
  const Meeting({
    required this.code,
    required this.title,
    required this.kind,
    required this.section,
    required this.day,
    required this.start,
    required this.end,
    this.location = '',
    this.building = '',
    this.from,
    this.until,
    this.exdates = const [],
  });

  final String code; // CSC373H1
  final String title;
  final String kind; // LEC / TUT / PRA
  final String section; // LEC0101
  final int day; // 周一=1 … 周日=7，和 DateTime.weekday 一致
  final String start; // "13:00"
  final String end;
  final String location; // "SF 3202"
  final String building;
  final String? from; // 第一次上课 "2026-09-09"
  final String? until; // 最后一次上课
  final List<String> exdates; // 停课日（Reading Week、假期）

  int get startMin => clockToMinutes(start);
  int get endMin => clockToMinutes(end);

  /// 这一天是否真的上课：星期对得上、在起止日期内、不是停课日。
  bool occursOn(DateTime d) {
    final day = ymd(d);
    return d.weekday == this.day &&
        (from == null || day.compareTo(from!) >= 0) &&
        (until == null || day.compareTo(until!) <= 0) &&
        !exdates.contains(day);
  }

  Map<String, dynamic> toJson() => {
        'code': code,
        'title': title,
        'kind': kind,
        'section': section,
        'day': day,
        'start': start,
        'end': end,
        'location': location,
        'building': building,
        'from': from,
        'until': until,
        'exdates': exdates,
      };

  factory Meeting.fromJson(Map<String, dynamic> j) => Meeting(
        code: j['code'] as String,
        title: j['title'] as String? ?? '',
        kind: j['kind'] as String? ?? '',
        section: j['section'] as String? ?? '',
        day: j['day'] as int,
        start: j['start'] as String,
        end: j['end'] as String,
        location: j['location'] as String? ?? '',
        building: j['building'] as String? ?? '',
        from: j['from'] as String?,
        until: j['until'] as String?,
        exdates: (j['exdates'] as List? ?? const []).cast<String>(),
      );
}

class Course {
  Course({required this.code, required this.title, this.credits = ''});

  final String code;
  String title;
  final String credits;

  Map<String, dynamic> toJson() => {'code': code, 'title': title, 'credits': credits};

  factory Course.fromJson(Map<String, dynamic> j) =>
      Course(code: j['code'] as String, title: j['title'] as String? ?? '', credits: j['credits'] as String? ?? '');
}

class Term {
  const Term({
    required this.id,
    required this.name,
    required this.start,
    required this.end,
    required this.courses,
    required this.meetings,
  });

  final String id; // 20269 = 2026 秋季，20271 = 2027 冬季，20265 = 2026 夏季
  final String name;
  final String start;
  final String end;
  final List<Course> courses;
  final List<Meeting> meetings;

  bool contains(DateTime d) {
    final day = ymd(d);
    return day.compareTo(start) >= 0 && day.compareTo(end) <= 0;
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'start': start,
        'end': end,
        'courses': [for (final c in courses) c.toJson()],
        'meetings': [for (final m in meetings) m.toJson()],
      };

  factory Term.fromJson(Map<String, dynamic> j) => Term(
        id: j['id'] as String,
        name: j['name'] as String,
        start: j['start'] as String,
        end: j['end'] as String,
        courses: [for (final c in j['courses'] as List) Course.fromJson(c as Map<String, dynamic>)],
        meetings: [for (final m in j['meetings'] as List) Meeting.fromJson(m as Map<String, dynamic>)],
      );
}

/// 成绩单上的一门课。
class GradedCourse {
  GradedCourse({
    required this.code,
    required this.title,
    required this.weight,
    this.mark = '',
    this.grade = '',
    this.avg = '',
  });

  final String code;
  String title;
  final String weight; // 学分 "0.50"
  final String mark; // 百分制分数
  final String grade; // A- / CR / IPR …
  final String avg; // 全班均分（等级）

  /// 还没出分（IPR = In Progress）
  bool get pending => grade.isEmpty || grade.toUpperCase() == 'IPR';

  Map<String, dynamic> toJson() =>
      {'code': code, 'title': title, 'weight': weight, 'mark': mark, 'grade': grade, 'avg': avg};

  factory GradedCourse.fromJson(Map<String, dynamic> j) => GradedCourse(
        code: j['code'] as String,
        title: j['title'] as String? ?? '',
        weight: j['weight'] as String? ?? '',
        mark: j['mark'] as String? ?? '',
        grade: j['grade'] as String? ?? '',
        avg: j['avg'] as String? ?? '',
      );
}

class AcademicSession {
  AcademicSession({
    required this.name,
    List<GradedCourse>? courses,
    this.sessionalGpa,
    this.annualGpa,
    this.cumulativeGpa,
    this.average,
    List<String>? notes,
  })  : courses = courses ?? [],
        notes = notes ?? [];

  final String name; // "2025 冬季"
  final List<GradedCourse> courses;
  String? sessionalGpa;
  String? annualGpa;
  String? cumulativeGpa;
  String? average; // Sessional % Average
  final List<String> notes;

  bool get allPending => courses.every((c) => c.pending);

  Map<String, dynamic> toJson() => {
        'name': name,
        'courses': [for (final c in courses) c.toJson()],
        'sessionalGpa': sessionalGpa,
        'annualGpa': annualGpa,
        'cumulativeGpa': cumulativeGpa,
        'average': average,
        'notes': notes,
      };

  factory AcademicSession.fromJson(Map<String, dynamic> j) => AcademicSession(
        name: j['name'] as String,
        courses: [for (final c in j['courses'] as List) GradedCourse.fromJson(c as Map<String, dynamic>)],
        sessionalGpa: j['sessionalGpa'] as String?,
        annualGpa: j['annualGpa'] as String?,
        cumulativeGpa: j['cumulativeGpa'] as String?,
        average: j['average'] as String?,
        notes: (j['notes'] as List? ?? const []).cast<String>(),
      );
}

class Transcript {
  const Transcript({required this.sessions, this.cgpa});

  final List<AcademicSession> sessions; // 从早到晚
  final String? cgpa;

  Map<String, dynamic> toJson() => {'sessions': [for (final s in sessions) s.toJson()], 'cgpa': cgpa};

  factory Transcript.fromJson(Map<String, dynamic> j) => Transcript(
        sessions: [for (final s in j['sessions'] as List) AcademicSession.fromJson(s as Map<String, dynamic>)],
        cgpa: j['cgpa'] as String?,
      );
}

class AcornData {
  const AcornData({required this.fetchedAt, required this.terms, this.transcript});

  final DateTime fetchedAt;
  final List<Term> terms;
  final Transcript? transcript;

  Map<String, dynamic> toJson() => {
        'fetchedAt': fetchedAt.toIso8601String(),
        'terms': [for (final t in terms) t.toJson()],
        'transcript': transcript?.toJson(),
      };

  factory AcornData.fromJson(Map<String, dynamic> j) => AcornData(
        fetchedAt: DateTime.parse(j['fetchedAt'] as String),
        terms: [for (final t in j['terms'] as List) Term.fromJson(t as Map<String, dynamic>)],
        transcript: j['transcript'] == null ? null : Transcript.fromJson(j['transcript'] as Map<String, dynamic>),
      );
}
