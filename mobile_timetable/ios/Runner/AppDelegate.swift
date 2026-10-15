import Flutter
import UIKit
import WidgetKit

/// Flutter 3.41+ / UIScene lifecycle. See ios/README.md for older Flutter hosts.
@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
    func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
        GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
        if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "TimetableBridge") {
            TimetableBridge.register(with: registrar)
        }
    }

    override func applicationDidBecomeActive(_ application: UIApplication) {
        super.applicationDidBecomeActive(application)
        TimetableLinkRouter.notifyIfPending()
        WidgetCenter.shared.reloadTimelines(ofKind: TimetableConfiguration.widgetKind)
    }

    override func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        if TimetableLinkRouter.capture(url) {
            return true
        }
        return super.application(app, open: url, options: options)
    }
}
