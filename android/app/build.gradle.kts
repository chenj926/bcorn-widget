plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.acorn.widget"
    compileSdk = 35
    // Separate installed identity preserves the legacy app and its private data.
    defaultConfig { applicationId = "com.bcorn.widget"; minSdk = 26; targetSdk = 35; versionCode = 4; versionName = "0.3.1" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    // Never let AGP silently create a new debug signing identity after environment reset.
    buildTypes {
        getByName("debug") { signingConfig = null }
        getByName("release") { isDebuggable = false; signingConfig = null }
    }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/rendererAssets"))
}
val syncRenderer by tasks.registering(Sync::class) {
    into(layout.buildDirectory.dir("generated/rendererAssets/src"))
    from("../../src/renderer") { into("renderer"); exclude("mock.js") }
    from("../../src/shared") { into("shared") }
}
tasks.named("preBuild") { dependsOn(syncRenderer) }

// Native-only Google authorization; tokens never cross into the WebView.
dependencies {
    implementation("com.google.android.gms:play-services-auth:22.0.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
