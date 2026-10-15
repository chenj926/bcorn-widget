// Pure-Dart smoke checks; no Flutter/package dependencies required.
import 'dart:convert';
import 'dart:io';
import '../lib/timetable.dart';

void main() {
  var count = 0;
  void check(bool value, String name) {
    if (!value) throw StateError(name);
    count++;
  }

  final course = Course(
    id: 'test',
    title: '测试',
    weekday: 1,
    startMinutes: 540,
    endMinutes: 600,
    startDate: '2026-10-12',
    endDate: '2026-10-19',
  );
  check(course.currentAt(DateTime(2026, 10, 12, 9)), 'start inclusive');
  check(!course.currentAt(DateTime(2026, 10, 12, 10)), 'end exclusive');
  check(!course.occursOn(DateTime(2026, 10, 5)), 'before semester');
  check(course.occursOn(DateTime(2026, 10, 19)), 'semester end inclusive');
  check(!course.occursOn(DateTime(2026, 10, 26)), 'semester expired');
  check(!course.occursOn(DateTime(2026, 10, 13)), 'wrong weekday');
  final table = Timetable([course]);
  check(table.nextToday(DateTime(2026, 10, 12, 8))?.id == 'test', 'next class');
  check(table.nextToday(DateTime(2026, 10, 12, 9)) == null, 'started not next');
  check(
    Timetable.decode(table.encode()).courses.single.title == '测试',
    'json round trip',
  );
  check(
    table.remove('test').courses.isEmpty && table.courses.length == 1,
    'immutable delete',
  );
  check(isSafeLink('https://example.com/a'), 'https allowed');
  check(isSafeLink('geo:43.6,-79.4'), 'geo allowed');
  check(!isSafeLink('javascript:alert(1)'), 'javascript blocked');
  check(!isSafeLink('file:///tmp/a'), 'file blocked');
  check(!isSafeLink('intent://evil'), 'intent blocked');
  check(
    !isSafeLink('https://user:password@example.com'),
    'embedded credentials blocked',
  );
  check(
    Uri.parse(googleMapsLink('上海 & 大学')).queryParameters['query'] == '上海 & 大学',
    'Google escaping',
  );
  check(
    Uri.parse(amapLink('上海 & 大学')).queryParameters['keyword'] == '上海 & 大学',
    'AMap escaping',
  );
  try {
    Timetable.decode('{"version":2,"courses":[]}');
    throw StateError('schema accepted');
  } on FormatException {
    count++;
  }
  try {
    Timetable.decode(
      jsonEncode({
        'version': 1,
        'courses': [course.toJson(), course.toJson()],
      }),
    );
    throw StateError('duplicates accepted');
  } on FormatException {
    count++;
  }
  try {
    parseDate('2026-02-30');
    throw StateError('bad date accepted');
  } on FormatException {
    count++;
  }
  stdout.writeln('PASS: $count pure-Dart model checks');
}
