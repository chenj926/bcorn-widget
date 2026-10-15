import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:bcorn_mobile/main.dart';
import 'package:bcorn_mobile/platform_store.dart';
import 'package:bcorn_mobile/timetable.dart';

class MemoryStore extends PlatformStore {
  Timetable data = Timetable.empty();
  bool failLoad = false, failSave = false;
  int writes = 0;
  final List<String> opened = [];
  String? pendingCourseId;
  @override
  Future<String?> takePendingCourseId() async {
    final id = pendingCourseId;
    pendingCourseId = null;
    return id;
  }

  @override
  Future<Timetable> load() async {
    if (failLoad) throw Exception('read');
    return data;
  }

  @override
  Future<void> save(Timetable value) async {
    if (failSave) throw Exception('write');
    data = value;
    writes++;
  }

  @override
  Future<bool> openUrl(String value) async {
    opened.add(value);
    return true;
  }

  @override
  Future<bool> requestPinWidget() async => false;
}

void phoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(430, 932);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('empty state, add, save, edit, cancel, persistence reload', (
    tester,
  ) async {
    phoneViewport(tester);
    final store = MemoryStore();
    await tester.pumpWidget(BcornApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('从第一门课开始'), findsOneWidget);
    await tester.tap(find.text('添加课程'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, '线性代数');
    await tester.tap(find.text('保存').first);
    await tester.pumpAndSettle();
    expect(store.data.courses.length, 1);
    expect(store.data.courses.single.title, '线性代数');
    final card = find.byKey(
      ValueKey('course-card-${store.data.courses.single.id}'),
    );
    await tester.ensureVisible(card);
    await tester.pumpAndSettle();
    await tester.tap(card);
    await tester.pumpAndSettle();
    await tester.tap(find.text('编辑'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, '取消的修改');
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(store.data.courses.single.title, '线性代数');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    await tester.pumpWidget(BcornApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('线性代数'), findsWidgets);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('load failure blocks editing and preserves store', (
    tester,
  ) async {
    phoneViewport(tester);
    final store = MemoryStore()..failLoad = true;
    await tester.pumpWidget(BcornApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('重试'), findsOneWidget);
    expect(find.text('添加课程'), findsNothing);
    expect(store.writes, 0);
    store.failLoad = false;
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(find.text('从第一门课开始'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('failed save reports error and keeps previous timetable', (
    tester,
  ) async {
    phoneViewport(tester);
    final store = MemoryStore()..failSave = true;
    await tester.pumpWidget(BcornApp(store: store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('添加课程'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, '不能保存');
    await tester.tap(find.text('保存').first);
    await tester.pumpAndSettle();
    expect(store.data.courses, isEmpty);
    expect(find.text('保存失败，请重试。你的修改没有覆盖原课表。'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('invalid class name cannot save and demo is opt-in', (
    tester,
  ) async {
    phoneViewport(tester);
    final store = MemoryStore();
    await tester.pumpWidget(BcornApp(store: store));
    await tester.pumpAndSettle();
    expect(store.data.courses, isEmpty);
    await tester.tap(find.text('添加课程'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存').first);
    await tester.pumpAndSettle();
    expect(find.text('请输入课程名称'), findsOneWidget);
    expect(store.writes, 0);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('先看看示例课表'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('先看看示例课表'));
    await tester.pumpAndSettle();
    expect(store.data.courses.length, 3);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'tap shows details only; long press navigates only after explicit choice',
    (tester) async {
      phoneViewport(tester);
      final store = MemoryStore()
        ..data = Timetable([
          Course(
            id: 'sample',
            title: '测试课程',
            weekday: DateTime.now().weekday,
            startMinutes: 540,
            endMinutes: 600,
            location: '多伦多大学',
          ),
        ]);
      await tester.pumpWidget(BcornApp(store: store));
      await tester.pumpAndSettle();
      final card = find.byKey(const ValueKey('course-card-sample'));
      await tester.ensureVisible(card);
      await tester.pumpAndSettle();
      await tester.tap(card);
      await tester.pumpAndSettle();
      expect(find.text('上课时间'), findsOneWidget);
      expect(find.text('Google Maps'), findsNothing);
      expect(find.text('导航到上课地点'), findsNothing);
      expect(store.opened, isEmpty);
      await tester.longPress(find.text('上课地点'));
      await tester.pumpAndSettle();
      expect(find.text('导航到上课地点'), findsOneWidget);
      expect(store.opened, isEmpty);
      await tester.tap(find.text('导航到上课地点'));
      await tester.pumpAndSettle();
      expect(find.text('Google Maps'), findsOneWidget);
      expect(find.text('高德地图'), findsOneWidget);
      expect(store.opened, isEmpty);
      await tester.tap(find.text('Google Maps'));
      await tester.pumpAndSettle();
      expect(store.opened.length, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets('widget cold-start opens exact course detail without maps', (
    tester,
  ) async {
    phoneViewport(tester);
    final store = MemoryStore()
      ..data = Timetable([
        Course(
          id: 'deep-link',
          title: '组件跳转课程',
          weekday: 1,
          startMinutes: 540,
          endMinutes: 600,
        ),
      ])
      ..pendingCourseId = 'deep-link';
    await tester.pumpWidget(BcornApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('上课时间'), findsOneWidget);
    expect(find.text('组件跳转课程'), findsWidgets);
    expect(store.pendingCourseId, isNull);
    expect(store.opened, isEmpty);
    await tester.tap(find.byTooltip('关闭详情'));
    await tester.pumpAndSettle();
    expect(find.text('上课时间'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('delete requires confirmation and persists removal', (
    tester,
  ) async {
    phoneViewport(tester);
    final store = MemoryStore()
      ..data = Timetable([
        Course(
          id: 'remove',
          title: '待删除课程',
          weekday: DateTime.now().weekday,
          startMinutes: 540,
          endMinutes: 600,
        ),
      ]);
    await tester.pumpWidget(BcornApp(store: store));
    await tester.pumpAndSettle();
    final card = find.byKey(const ValueKey('course-card-remove'));
    await tester.ensureVisible(card);
    await tester.pumpAndSettle();
    await tester.tap(card);
    await tester.pumpAndSettle();
    await tester.tap(find.text('编辑'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('删除这门课程'),
      400,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('删除这门课程'));
    await tester.pumpAndSettle();
    expect(store.data.courses.length, 1);
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();
    expect(store.data.courses, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });
}
