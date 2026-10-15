// Generates a real Flutter-rendered preview with explicitly fake demo data.
// Run only on Linux QA hosts with Noto CJK installed:
// flutter test test/preview_test.dart --dart-define=GENERATE_PREVIEW=true
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:bcorn_mobile/main.dart';
import 'package:bcorn_mobile/platform_store.dart';
import 'package:bcorn_mobile/timetable.dart';

class PreviewStore extends PlatformStore {
  @override
  Future<Timetable> load() async => Timetable.demo(DateTime.now());
}

void main() {
  const enabled = bool.fromEnvironment('GENERATE_PREVIEW');
  testWidgets('render app preview with sample timetable', (tester) async {
    await tester.runAsync(() async {
      final file = File(
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      );
      if (await file.exists()) {
        final data = ByteData.sublistView(await file.readAsBytes());
        for (final family in ['Roboto', 'Ahem']) {
          final loader = FontLoader(family)..addFont(Future.value(data));
          await loader.load();
        }
      }
    });
    await tester.runAsync(() async {
      final icons = File(
        'build/unit_test_assets/fonts/MaterialIcons-Regular.otf',
      );
      if (icons.existsSync()) {
        final loader = FontLoader(
          'MaterialIcons',
        )..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())));
        await loader.load();
      }
    });
    debugDisableShadows = false;
    addTearDown(() => debugDisableShadows = true);
    tester.view.physicalSize = const Size(860, 1864);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final key = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: BcornApp(store: PreviewStore()),
      ),
    );
    await tester.pumpAndSettle();
    Future<void> capture(String filename) async {
      await tester.runAsync(() async {
        final boundary =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 2);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        File('docs/$filename').writeAsBytesSync(png!.buffer.asUint8List());
        image.dispose();
      });
    }

    await capture('preview-today.png');
    final card = find.byKey(const ValueKey('course-card-demo-1'));
    await tester.ensureVisible(card);
    await tester.pumpAndSettle();
    await tester.tap(card);
    await tester.pumpAndSettle();
    await capture('preview-detail.png');
    debugDisableShadows = true;
    await tester.pumpWidget(const SizedBox());
  }, skip: !enabled);
}
