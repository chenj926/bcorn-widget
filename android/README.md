# Android 原生外壳与桌面课表小组件

此目录是 Kotlin / Android SDK 原生项目，不使用 Flutter、Compose、AndroidX 或 WebView 替代页面。应用内继续使用仓库的 `src/renderer/index.html`、`styles.css`、`app.js` 和 `src/shared/course-tools.js`。构建阶段复制原文件；Android 只在本地 HTML 响应中插入 `android-bridge.js` 适配器。演示 `mock.js` 不进入安装包。

## 当前已实现

- Android Activity + 系统 WebView，今天 / 学期课表 / 成绩及课程编辑由同一 renderer 呈现。
- 系统文件选择器导入 JSON，交给共享校验、预览及替换确认；确认后写入应用私有目录并更新桌面组件。
- ICS / JSON 使用系统“保存文件”选择目标，不静默写共享存储。
- 菜单中的“清除本地数据”须先确认，之后仅删除应用私有课表缓存并清空桌面组件；不删除用户原始文件或已导出的文件。
- 本地缓存使用 AtomicFile 原子替换，不申请存储权限；禁止云备份和设备迁移。未另做应用级加密，依赖 Android 应用沙箱和设备本身的存储保护。
- 原生 `AppWidgetProvider` / `RemoteViews` 周网格。建议 5×7；可横纵调整，窄小尺寸减小字号、简化房间/时间等附加文字。周末存在课时才显示。
- 课程颜色、并排重叠课时；候补课虚线和“候补”标签；候补 / TBA 计数；TalkBack 课表摘要。
- 点按整个桌面组件打开应用内课表。课程逐项详情、编辑、地图及长按菜单在应用内；桌面长按由手机启动器控制，不能覆盖其拖动/缩放行为。
- 地图只允许 Google Maps / 高德地图 HTTPS 地址，由外部地图/浏览器打开。

## 明确边界

- Android 版本目前只用本地数据。没有 ACORN 登录、联网刷新或会话保持；界面明确提示不支持。刷新不会伪造成功或更新时间。
- 桌面网格是“学期周课表模板”，不会把假期或某周的停课情况误当实时课程，也不显示可能过期的“现在”线。具体发生日期、停课日和日历导出由共享模型/应用内详情处理。
- 小组件在添加、调整大小、应用进入前台及保存数据后重绘。没有周期性刷新、AlarmManager、WorkManager、Service、推送或联网权限。跨越学期日期后，打开应用即可重选学期。
- 5×7 是启动器建议值；Vivo 等启动器实际网格、最小尺寸、圆角、缩放手势由系统决定。
- 课程详情可选择“在系统日历中预览下一次上课（单次）”，跳过停课日、排除候补，打开系统事件编辑器供使用者审阅并保存。bridge 返回的是 `opened: true, saved: false`，不声称事件已保存；整个学期仍用 ICS 导出。不申请日历读写权限。
- 需要 Android 8.0+（API 26）和较新的 Android System WebView。未在 Vivo 真机或模拟器上验证，不能把编译成功等同于设备兼容性验证。

## 标准构建

安装 JDK 17+、Android SDK Platform 35、Build Tools 35.0.0。使用 Android Studio 打开此目录，或：

```sh
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug
```

Gradle 8.13 wrapper 已包含，AGP 8.9.2、Kotlin 2.0.21。SDK 路径可在未提交的 `local.properties` 设置 `sdk.dir=...`。输出通常在 `app/build/outputs/apk/debug/app-debug.apk`。首次构建需下载官方 Gradle / Maven 依赖，SDK 许可需由使用者确认。

## 受限网络环境的可复现构建

当 SDK/Gradle 的 JVM 无法联网，但官方工具已安装时，提供无依赖下载的实际构建脚本：

```sh
export ANDROID_HOME=/path/to/android-sdk
export GRADLE_HOME=/path/to/gradle-8.13
./scripts/build-offline.sh
```

脚本使用官方 Build Tools 的 aapt2、D8、zipalign、apksigner，以及 Gradle 8.13 自带 Kotlin 2.0.21 编译器与 stdlib；JDK 编译 R.java。脚本不下载工具、不接受许可、不改变系统安全设置。输出 `app/build/offline/acorn-android-debug.apk`，并验证 APK 签名及输出 SHA-256。本地测试签名密钥在 `app/build/`，不会提交；这不是正式发布签名。

当前已完成该离线编译及 APK v2/v3 签名验证。标准 Gradle Android 构建因运行环境 JVM 网络不可达未完成；Gradle wrapper 的生成已成功。最终 APK 中 renderer 是否最新，须在其改动完毕后重跑构建。

## 检查

```sh
node tests/bridge.test.cjs
```

检查 bridge 调用、回调、失败与取消语义，及无权限/无服务/无定时刷新、5×7 可缩放声明。

另可在仓库安装开发依赖后运行移动尺寸 Chromium 集成测试：

```sh
CHROME_BIN=/path/to/chrome-headless-shell node tests/renderer-smoke.cjs
```

该测试加载真实 Android JavaScript bridge，但以合成数据模拟原生回调，覆盖未登录空态、导入预览确认、缓存保存、候补渲染和原生日历文件导出。它不是 Android WebView / 真机运行时测试。见 `TESTING.md` 的设备验收步骤。
