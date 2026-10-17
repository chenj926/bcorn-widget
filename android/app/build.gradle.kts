plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.acorn.widget"
    compileSdk = 35
    defaultConfig { applicationId = "com.acorn.widget"; minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "0.1.0" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/rendererAssets"))
}
val syncRenderer by tasks.registering(Sync::class) {
    into(layout.buildDirectory.dir("generated/rendererAssets/src"))
    from("../../src/renderer") { into("renderer"); exclude("mock.js") }
    from("../../src/shared") { into("shared") }
}
tasks.named("preBuild") { dependsOn(syncRenderer) }
