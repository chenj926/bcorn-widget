import 'package:flutter/services.dart';
import 'timetable.dart';

/// Owns persistence, external navigation, and queued widget-to-course routing.
/// Domain/UI callers do not know which native preference store is used.
class PlatformStore {
  static const channel = MethodChannel('io.bcorn.mobile/timetable');
  Future<Timetable> load() async {
    final raw = await channel.invokeMethod<String>('load');
    return raw == null || raw.isEmpty
        ? Timetable.empty()
        : Timetable.decode(raw);
  }

  Future<void> save(Timetable table) async {
    await channel.invokeMethod<Object?>('save', {'json': table.encode()});
  }

  Future<bool> openUrl(String url) async {
    if (url.isEmpty || !isSafeLink(url)) return false;
    return await channel.invokeMethod<bool>('openUrl', {'url': url}) ?? false;
  }

  Future<bool> requestPinWidget() async =>
      await channel.invokeMethod<bool>('requestPinWidget') ?? false;
  Future<String?> takePendingCourseId() async {
    try {
      return await channel.invokeMethod<String>('getPendingCourseId');
    } on MissingPluginException {
      return null;
    }
  }

  void onCourseLinkAvailable(Future<void> Function()? handler) {
    channel.setMethodCallHandler(
      handler == null
          ? null
          : (call) async {
              if (call.method == 'courseLinkAvailable') await handler();
            },
    );
  }
}
