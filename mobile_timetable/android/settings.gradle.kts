pluginManagement {
    val flutterSdkPath = run {
        val properties = java.util.Properties()
        file("local.properties").inputStream().use { properties.load(it) }
        val sdk = properties.getProperty("flutter.sdk")
        require(sdk != null) { "flutter.sdk is missing from android/local.properties. Run flutter pub get first." }
        sdk
    }
    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.11.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
}
include(":app")
