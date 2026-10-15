import 'dart:convert';

const dayLabels = ['一', '二', '三', '四', '五', '六', '日'];
const courseColors = [
  0xff487a70,
  0xffbb765c,
  0xff6979a4,
  0xffac8641,
  0xff8c6993,
];

String dateKey(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
String minuteLabel(int m) =>
    '${(m ~/ 60).toString().padLeft(2, '0')}:${(m % 60).toString().padLeft(2, '0')}';
DateTime dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);
DateTime shiftDays(DateTime d, int days) =>
    DateTime(d.year, d.month, d.day + days);

DateTime? parseDate(String? value) {
  if (value == null || value.isEmpty) return null;
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value))
    throw const FormatException('日期格式应为 YYYY-MM-DD');
  final d = DateTime.tryParse(value);
  if (d == null || dateKey(d) != value) throw const FormatException('日期无效');
  return d;
}

bool isSafeLink(String value) {
  if (value.trim().isEmpty) return true;
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      !uri.hasScheme ||
      RegExp(r'[\x00-\x20]').hasMatch(value.trim()))
    return false;
  if (['http', 'https'].contains(uri.scheme.toLowerCase()))
    return uri.host.isNotEmpty && uri.userInfo.isEmpty;
  return [
    'geo',
    'google.navigation',
    'amapuri',
    'iosamap',
    'androidamap',
    'maps',
  ].contains(uri.scheme.toLowerCase());
}

String googleMapsLink(String place) => Uri.https(
  'www.google.com',
  '/maps/search/',
  {'api': '1', 'query': place.trim()},
).toString();
String amapLink(String place) => Uri.https('uri.amap.com', '/search', {
  'keyword': place.trim(),
  'src': 'bcorn-mobile',
  'callnative': '1',
}).toString();

class Course {
  final String id, title, location, mapUrl, notes;
  final int weekday, startMinutes, endMinutes, color;
  final String? startDate, endDate;
  const Course({
    required this.id,
    required this.title,
    required this.weekday,
    required this.startMinutes,
    required this.endMinutes,
    this.location = '',
    this.mapUrl = '',
    this.notes = '',
    this.color = 0xff487a70,
    this.startDate,
    this.endDate,
  });

  factory Course.fromJson(Map<String, dynamic> json) {
    String str(String k, [String fallback = '']) {
      final v = json[k];
      if (v == null) return fallback;
      if (v is! String) throw FormatException('$k 必须是文字');
      return v;
    }

    int integer(String k, [int? fallback]) {
      final v = json[k] ?? fallback;
      if (v is! int) throw FormatException('$k 必须是整数');
      return v;
    }

    final c = Course(
      id: str('id'),
      title: str('title'),
      weekday: integer('weekday'),
      startMinutes: integer('startMinutes'),
      endMinutes: integer('endMinutes'),
      location: str('location'),
      mapUrl: str('mapUrl'),
      notes: str('notes'),
      color: integer('color', courseColors.first),
      startDate: json['startDate'] == null || json['startDate'] == ''
          ? null
          : str('startDate'),
      endDate: json['endDate'] == null || json['endDate'] == ''
          ? null
          : str('endDate'),
    );
    final error = c.validationError;
    if (error != null) throw FormatException(error);
    return c;
  }

  String? get validationError {
    if (id.trim().isEmpty || id.length > 128) return '课程 ID 无效';
    if (title.trim().isEmpty || title.length > 120) return '课程名称需为 1–120 个字符';
    if (weekday < 1 || weekday > 7) return '星期无效';
    if (startMinutes < 0 ||
        startMinutes > 1439 ||
        endMinutes <= startMinutes ||
        endMinutes > 1440)
      return '结束时间必须晚于开始时间（跨夜课程请分两条）';
    if (location.length > 500 || notes.length > 4000 || mapUrl.length > 4000)
      return '课程内容太长';
    if (!isSafeLink(mapUrl)) return '请使用有效的网页或地图链接';
    if (color < 0 || color > 0xffffffff) return '颜色无效';
    try {
      final start = parseDate(startDate), end = parseDate(endDate);
      if (start != null && end != null && end.isBefore(start))
        return '学期结束日期不能早于开始日期';
    } on FormatException catch (e) {
      return e.message;
    }
    return null;
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title.trim(),
    'weekday': weekday,
    'startMinutes': startMinutes,
    'endMinutes': endMinutes,
    'location': location.trim(),
    'mapUrl': mapUrl.trim(),
    'notes': notes.trim(),
    'color': color,
    'startDate': startDate,
    'endDate': endDate,
  };
  bool occursOn(DateTime day) {
    if (day.weekday != weekday) return false;
    final key = dateKey(day);
    return (startDate == null ||
            startDate!.isEmpty ||
            key.compareTo(startDate!) >= 0) &&
        (endDate == null || endDate!.isEmpty || key.compareTo(endDate!) <= 0);
  }

  bool currentAt(DateTime now) =>
      occursOn(now) &&
      now.hour * 60 + now.minute >= startMinutes &&
      now.hour * 60 + now.minute < endMinutes;
  String get timeLabel =>
      '${minuteLabel(startMinutes)} – ${minuteLabel(endMinutes)}';
  String get destination => mapUrl.trim().isNotEmpty
      ? mapUrl.trim()
      : location.trim().isNotEmpty
      ? googleMapsLink(location)
      : '';
}

class Timetable {
  final List<Course> courses;
  final DateTime updatedAt;
  Timetable(List<Course> courses, {DateTime? updatedAt})
    : courses = List.unmodifiable(courses),
      updatedAt = updatedAt ?? DateTime.now();
  factory Timetable.empty() => Timetable([]);
  factory Timetable.decode(String source) {
    if (utf8.encode(source).length > 1000000)
      throw const FormatException('课表文件过大');
    final obj = jsonDecode(source);
    if (obj is! Map<String, dynamic> ||
        obj['version'] != 1 ||
        obj['courses'] is! List)
      throw const FormatException('这不是支持的 v1 课表文件');
    final list = obj['courses'] as List;
    if (list.length > 500) throw const FormatException('最多支持 500 门课程');
    final courses = list.map((item) {
      if (item is! Map<String, dynamic>) throw const FormatException('课程数据无效');
      return Course.fromJson(item);
    }).toList();
    if (courses.map((c) => c.id).toSet().length != courses.length)
      throw const FormatException('课程 ID 重复');
    return Timetable(
      courses,
      updatedAt:
          DateTime.tryParse(
            obj['updatedAt'] is String ? obj['updatedAt'] : '',
          ) ??
          DateTime.now(),
    );
  }
  String encode({bool pretty = false}) {
    final obj = {
      'version': 1,
      'updatedAt': updatedAt.toUtc().toIso8601String(),
      'courses': courses.map((c) => c.toJson()).toList(),
    };
    return pretty
        ? const JsonEncoder.withIndent('  ').convert(obj)
        : jsonEncode(obj);
  }

  List<Course> onDay(DateTime day) =>
      courses.where((c) => c.occursOn(day)).toList()..sort((a, b) {
        final time = a.startMinutes.compareTo(b.startMinutes);
        return time != 0 ? time : a.title.compareTo(b.title);
      });
  List<Course> current(DateTime now) =>
      onDay(now).where((c) => c.currentAt(now)).toList();
  Course? nextToday(DateTime now) {
    final future = onDay(
      now,
    ).where((c) => c.startMinutes > now.hour * 60 + now.minute);
    return future.isEmpty ? null : future.first;
  }

  Timetable upsert(Course c) =>
      Timetable([...courses.where((old) => old.id != c.id), c]);
  Timetable remove(String id) =>
      Timetable(courses.where((c) => c.id != id).toList());
  static Timetable demo(DateTime now) => Timetable([
    Course(
      id: 'demo-1',
      title: '设计与生活',
      weekday: now.weekday,
      startMinutes: 540,
      endMinutes: 630,
      location: '示例教学楼 · 201',
      notes: '示例课程，可以编辑或删除',
      color: courseColors[0],
    ),
    Course(
      id: 'demo-2',
      title: '数据与世界',
      weekday: now.weekday,
      startMinutes: 780,
      endMinutes: 870,
      location: '示例图书馆 · 3F',
      notes: '这是演示数据，请替换为你的课表',
      color: courseColors[1],
    ),
    Course(
      id: 'demo-3',
      title: '创意工作坊',
      weekday: now.weekday,
      startMinutes: 960,
      endMinutes: 1050,
      location: '示例实验室 · 102',
      color: courseColors[2],
    ),
  ]);
}
