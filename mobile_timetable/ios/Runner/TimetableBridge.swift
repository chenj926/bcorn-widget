import Flutter
import UIKit
import WidgetKit

final class TimetableBridge: NSObject, FlutterPlugin {
    private static var methodChannel: FlutterMethodChannel?

    static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: TimetableConfiguration.channelName,
            binaryMessenger: registrar.messenger()
        )
        methodChannel = channel
        registrar.addMethodCallDelegate(TimetableBridge(), channel: channel)
    }

    static func notifyCourseLinkAvailable() {
        methodChannel?.invokeMethod("courseLinkAvailable", arguments: nil)
    }

    func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "load":
            do { result(try TimetableStore.loadJSON()) }
            catch { result(Self.flutterError(error)) }
        case "save":
            guard let arguments = call.arguments as? [String: Any],
                  let json = arguments["json"] as? String else {
                result(FlutterError(code: "INVALID_ARGUMENT", message: "save expects {'json': String}.", details: nil))
                return
            }
            do {
                try TimetableStore.saveJSON(json)
                WidgetCenter.shared.reloadTimelines(ofKind: TimetableConfiguration.widgetKind)
                result(true)
            } catch { result(Self.flutterError(error)) }
        case "openUrl":
            guard let arguments = call.arguments as? [String: Any],
                  let value = arguments["url"] as? String,
                  let url = SafeMapURL.parse(value) else {
                result(FlutterError(code: "INVALID_URL", message: "Only valid web and map URLs are allowed.", details: nil))
                return
            }
            // The completion reports missing map apps or otherwise unsupported URLs.
            // canOpenURL is deliberately unnecessary; no device app inventory is read.
            UIApplication.shared.open(url, options: [:]) { success in result(success) }
        case "requestPinWidget":
            // iOS has no Android-style programmatic widget pin request API.
            result(false)
        case "getPendingCourseId":
            result(TimetableLinkRouter.takePendingCourseID())
        case "getPlatformInfo":
            let lockScreenSupported: Bool
            if #available(iOS 17.0, *) { lockScreenSupported = true }
            else if #available(iOS 16.0, *) { lockScreenSupported = UIDevice.current.userInterfaceIdiom == .phone }
            else { lockScreenSupported = false }
            result([
                "platform": "ios",
                "homeWidgetSupported": true,
                "lockScreenWidgetSupported": lockScreenSupported,
                "pinWidgetSupported": false,
                "alwaysOnControllable": false,
                "appGroupAvailable": (try? TimetableStore.defaults()) != nil
            ])
        default: result(FlutterMethodNotImplemented)
        }
    }

    private static func flutterError(_ error: Error) -> FlutterError {
        if let dataError = error as? TimetableDataError, case .appGroupUnavailable = dataError {
            return FlutterError(code: "APP_GROUP_UNAVAILABLE", message: error.localizedDescription, details: nil)
        }
        return FlutterError(code: "INVALID_DATA", message: error.localizedDescription, details: nil)
    }
}

/// Widget links queue a course ID for Flutter's enlarged detail view.
/// No incoming URL opens any map or external app. The pending ID survives engine
/// startup / a missing Dart handler until getPendingCourseId consumes it.
enum TimetableLinkRouter {
    private static var pendingCourseID: String?

    @discardableResult
    static func capture(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "bcorn" else { return false }
        guard url.host == "course" else { return url.host == "timetable" }
        guard let id = CourseWidgetURL.courseID(from: url) else { return true }
        pendingCourseID = id
        notifyIfPending()
        return true
    }

    static func takePendingCourseID() -> String? {
        let id = pendingCourseID
        pendingCourseID = nil
        return id
    }

    static func notifyIfPending() {
        guard pendingCourseID != nil else { return }
        TimetableBridge.notifyCourseLinkAvailable()
    }
}
