import Flutter
import UIKit
import WidgetKit

/// Covers widget URLs for both cold starts and an already running app.
@objc class BcornSceneDelegate: FlutterSceneDelegate {
    override func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        super.scene(scene, willConnectTo: session, options: connectionOptions)
        for context in connectionOptions.urlContexts {
            _ = TimetableLinkRouter.capture(context.url)
        }
    }

    override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let unhandled = URLContexts.filter { !TimetableLinkRouter.capture($0.url) }
        if !unhandled.isEmpty { super.scene(scene, openURLContexts: Set(unhandled)) }
    }

    override func sceneDidBecomeActive(_ scene: UIScene) {
        super.sceneDidBecomeActive(scene)
        TimetableLinkRouter.notifyIfPending()
        WidgetCenter.shared.reloadTimelines(ofKind: TimetableConfiguration.widgetKind)
    }
}
