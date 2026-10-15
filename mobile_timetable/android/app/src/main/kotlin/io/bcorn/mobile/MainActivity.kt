package io.bcorn.mobile

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var pendingCourseId: String? = null
    private var timetableChannel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        queueCourseIntent(intent)
        timetableChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        timetableChannel!!.setMethodCallHandler { call, result ->
            when (call.method) {
                "load" -> result.success(TimetableStore.load(this))
                "getPendingCourseId" -> {
                    val id = pendingCourseId
                    pendingCourseId = null
                    intent?.removeExtra(WidgetLinkActivity.EXTRA_COURSE_ID)
                    result.success(id)
                }
                "save" -> {
                    val json = call.argument<String>("json")
                    if (json == null) {
                        result.error("invalid_snapshot", "缺少课表 JSON", null)
                    } else {
                        try {
                            TimetableStore.save(this, json)
                            runCatching { TimetableWidgetProvider.refreshAll(this) }
                            result.success(true)
                        } catch (error: Exception) {
                            result.error("save_failed", error.message ?: "无法保存课表", null)
                        }
                    }
                }
                "openUrl" -> {
                    val url = call.argument<String>("url").orEmpty()
                    if (SafeLinks.validatedUri(url) == null) {
                        result.error("unsafe_url", "仅支持网页和地图链接", null)
                    } else {
                        result.success(SafeLinks.open(this, url))
                    }
                }
                "requestPinWidget" -> {
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                        result.success(false)
                    } else {
                        val manager = AppWidgetManager.getInstance(this)
                        val accepted = manager.isRequestPinAppWidgetSupported && manager.requestPinAppWidget(
                            ComponentName(this, TimetableWidgetProvider::class.java), null, null,
                        )
                        // True means the launcher accepted the request, not that the user placed it.
                        result.success(accepted)
                    }
                }
                "getPlatformInfo" -> result.success("Android ${Build.VERSION.RELEASE} · ${Build.MANUFACTURER} ${Build.MODEL}")
                else -> result.notImplemented()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (queueCourseIntent(intent)) {
            timetableChannel?.invokeMethod("courseLinkAvailable", null)
        }
    }

    private fun queueCourseIntent(intent: Intent?): Boolean {
        val id = intent?.getStringExtra(WidgetLinkActivity.EXTRA_COURSE_ID)?.takeIf { it.isNotBlank() }
        if (id == null) return false
        pendingCourseId = id
        // Keep the Activity extra until Dart consumes it, including during engine startup/recreation.
        return true
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        timetableChannel?.setMethodCallHandler(null)
        timetableChannel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onResume() {
        super.onResume()
        // Also repairs a stale header after OEM background throttling.
        TimetableWidgetProvider.refreshAll(this)
    }

    companion object {
        private const val CHANNEL = "io.bcorn.mobile/timetable"
    }
}
