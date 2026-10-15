import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:bcorn_mobile/timetable.dart';

Course sample({
  String id = 'a',
  int start = 540,
  int end = 600,
  int day = 1,
  String? from,
  String? until,
}) => Course(
  id: id,
  title: '线性代数',
  weekday: day,
  startMinutes: start,
  endMinutes: end,
  startDate: from,
  endDate: until,
);

void main() {
  group('schedule boundaries', () {
    test('start inclusive, end exclusive and local weekday', () {
      final c = sample();
      expect(c.currentAt(DateTime(2026, 10, 12, 8, 59)), isFalse);
      expect(c.currentAt(DateTime(2026, 10, 12, 9)), isTrue);
      expect(c.currentAt(DateTime(2026, 10, 12, 9, 59)), isTrue);
      expect(c.currentAt(DateTime(2026, 10, 12, 10)), isFalse);
      expect(c.currentAt(DateTime(2026, 10, 13, 9)), isFalse);
    });
    test('semester dates inclusive and expire', () {
      final c = sample(from: '2026-10-12', until: '2026-10-19');
      expect(c.occursOn(DateTime(2026, 10, 5)), isFalse);
      expect(c.occursOn(DateTime(2026, 10, 12)), isTrue);
      expect(c.occursOn(DateTime(2026, 10, 19)), isTrue);
      expect(c.occursOn(DateTime(2026, 10, 26)), isFalse);
    });
    test('simultaneous classes preserved; next only future today', () {
      final table = Timetable([
        sample(id: 'b', start: 570, end: 660),
        sample(id: 'a'),
        sample(id: 'c', start: 660, end: 720),
      ]);
      expect(table.current(DateTime(2026, 10, 12, 9, 45)).map((c) => c.id), [
        'a',
        'b',
      ]);
      expect(table.nextToday(DateTime(2026, 10, 12, 9, 45))?.id, 'c');
      expect(table.nextToday(DateTime(2026, 10, 12, 11)), isNull);
      expect(table.nextToday(DateTime(2026, 10, 13, 8)), isNull);
    });
    test('last minute and midnight', () {
      final c = sample(start: 1430, end: 1440);
      expect(c.currentAt(DateTime(2026, 10, 12, 23, 59)), isTrue);
      expect(c.currentAt(DateTime(2026, 10, 13)), isFalse);
      expect(minuteLabel(1440), '24:00');
    });
    test('reject invalid date, inverse ranges and overnight', () {
      expect(sample(from: '2026-02-30').validationError, isNotNull);
      expect(
        sample(from: '2026-12-01', until: '2026-01-01').validationError,
        isNotNull,
      );
      expect(sample(start: 600, end: 600).validationError, isNotNull);
      expect(sample(start: 1380, end: 60).validationError, isNotNull);
      expect(sample(day: 0).validationError, isNotNull);
    });
  });
  group('persistence and edits', () {
    test('JSON round trip preserves every field', () {
      final c = Course(
        id: 'abc',
        title: '测试课',
        weekday: 5,
        startMinutes: 123,
        endMinutes: 456,
        location: '教室 A',
        mapUrl: 'https://example.com/a?q=1',
        notes: '带笔',
        color: 0xff123456,
        startDate: '2026-09-01',
        endDate: '2026-12-31',
      );
      expect(
        Timetable.decode(Timetable([c]).encode()).courses.single.toJson(),
        c.toJson(),
      );
    });
    test('upsert then delete without mutating original', () {
      final original = Timetable([sample()]);
      final changed = original.upsert(sample(start: 600, end: 660));
      expect(original.courses.single.startMinutes, 540);
      expect(changed.courses.length, 1);
      expect(changed.courses.single.startMinutes, 600);
      expect(changed.remove('a').courses, isEmpty);
    });
    test('reject invalid schema, duplicates, unsafe URL, and broken JSON', () {
      for (final source in [
        '[]',
        '{}',
        'broken',
        '{"version":2,"courses":[]}',
      ]) {
        expect(() => Timetable.decode(source), throwsFormatException);
      }
      expect(
        () => Timetable.decode(Timetable([sample(), sample()]).encode()),
        throwsFormatException,
      );
      final raw =
          jsonDecode(Timetable([sample()]).encode()) as Map<String, dynamic>;
      raw['courses'][0]['mapUrl'] = 'javascript:alert(1)';
      expect(() => Timetable.decode(jsonEncode(raw)), throwsFormatException);
      raw['courses'][0]['mapUrl'] = '';
      raw['courses'][0]['weekday'] = 1.2;
      expect(() => Timetable.decode(jsonEncode(raw)), throwsFormatException);
    });
    test(
      'empty table is valid',
      () =>
          expect(Timetable.decode(Timetable.empty().encode()).courses, isEmpty),
    );
  });
  group('links', () {
    test('safe map/web URLs only', () {
      for (final url in [
        '',
        'https://maps.google.com/?q=Toronto',
        'geo:43.66,-79.39',
        'androidamap://viewMap?x=1',
        'iosamap://viewMap?x=1',
      ]) {
        expect(isSafeLink(url), isTrue, reason: url);
      }
      for (final url in [
        'javascript:alert(1)',
        'file:///tmp/a',
        'intent://evil',
        'https://',
        'https://user:pass@example.com',
        'just a place',
        'https://example.com/a b',
      ]) {
        expect(isSafeLink(url), isFalse, reason: url);
      }
    });
    test('locations are encoded without inserting URL parameters', () {
      final link = Uri.parse(googleMapsLink('上海 大学 & A栋'));
      expect(link.queryParameters['query'], '上海 大学 & A栋');
      expect(link.queryParameters.length, 2);
      expect(Uri.parse(amapLink('上海 大学')).queryParameters['keyword'], '上海 大学');
    });
  });
}
