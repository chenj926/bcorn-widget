# bcorn Android 原生外壳与桌面课表小组件

此目录是 Kotlin / Android SDK 原生项目，不使用 Flutter、Compose、AndroidX 或 WebView 替代页面。应用内继续使用仓库的 `src/renderer/index.html`、`styles.css`、`app.js` 和 `src/shared/course-tools.js`。构建阶段复制原文件；Android 只在本地 HTML 响应中插入 `android-bridge.js` 适配器。演示 `mock.js` 不进入安装包。

## 当前已实现

- Android Activity + 系统 WebView，今天 / 学期课表 / 成绩及课程编辑由同一 renderer 呈现。
- 系统文件选择器导入 JSON，交给共享校验、预览及替换确认；确认后写入应用私有目录并更新桌面组件。
- ICS / JSON 使用系统“保存文件”选择目标，不静默写共享存储。
- 菜单中的“清除本地数据”须先确认，之后仅删除应用私有课表缓存并清空桌面组件；不删除用户原始文件或已导出的文件。
- 本地缓存使用 AtomicFile 原子替换，不申请存储权限；禁止云备份和设备迁移。未另做应用级加密，依赖 Android 应用沙箱和设备本身的存储保护。
- 原生 `AppWidgetProvider` / `RemoteViews` 本周日期网格，遵守学期范围、课时起止日期、停课日与单次事项日期。建议 5×7；可横纵调整，窄小尺寸自动使用易读的本周日程列表（日期 / 时间 / 课程或事项），较大尺寸显示完整网格。周末存在课时才显示。
- 小组件选择器同时提供合成课表 `previewImage` 和 Android 12+ `previewLayout`，明确标记为示例，添加后才显示本地数据。旧版仅有应用图标的选择器画面是缺少预览资源，并不能证明放置后的 provider 不工作。
- 课程颜色、并排重叠课时；候补课虚线和“候补”标签；候补 / TBA 计数；TalkBack 课表摘要。
- 点按整个桌面组件打开应用内课表。课程逐项详情、编辑、地图及长按菜单在应用内；桌面长按由手机启动器控制，不能覆盖其拖动/缩放行为。
- 原生系统返回先交给页面关闭菜单、详情、编辑与选择；根页面 2 秒内再按一次返回桌面。关闭编辑时沿用未保存确认，取消后内容保留。Android 13+ 使用 OnBackInvokedDispatcher，旧版保留 onBackPressed。
- 地图只允许 Google Maps / 高德地图 HTTPS 地址，由外部地图/浏览器打开。

## 明确边界

- Android 版本目前只用本地数据。没有 ACORN 登录、联网刷新或会话保持；界面明确提示不支持。刷新不会伪造成功或更新时间。
- 桌面网格显示所选学期时区的本周实际课时，包含每周 / 单次个人事项；其他个人日历的事项叠加到主学期，按主学期时区换算日期与时间，跨午夜分段显示；单次事项不会在别的周重复。标题明确显示周一至周日的日期范围及课表时区，空周显示“本周暂无已排课程 / 事项”。不显示需要持续更新的“现在”线。
- 小组件在添加、调整大小、应用进入前台及保存 / 清除数据后重绘，并使用 Android 系统 `updatePeriodMillis=86400000` 尽力每日批量刷新本地日期与周课表。这不是精确午夜更新：休眠 / OEM 限制可能推迟；日期标题可识别显示的是哪一周，打开应用会立即重新计算。没有自建 AlarmManager、WorkManager、Service、推送、后台联网或保活。Launcher 持有最后一份 RemoteViews，应用退出 / 进程回收不需要保持 WebView 运行。系统设置中的“强行停止”可能阻止后续系统更新，重新打开应用即可恢复；不可等同于普通关闭应用。
- 5×7 是启动器建议值；Vivo 等启动器实际网格、最小尺寸、圆角、缩放手势由系统决定。
- 课程详情可选择“在系统日历中预览下一次上课（单次）”，跳过停课日、排除候补，打开系统事件编辑器供使用者审阅并保存。bridge 返回的是 `opened: true, saved: false`，不声称事件已保存；整个学期仍用 ICS 导出。不申请日历读写权限。
- 需要 Android 8.0+（API 26）和较新的 Android System WebView。未在 Vivo 真机或模拟器上验证，不能把编译或 JVM 主机测试等同于设备兼容性验证。详细证据见 `TESTING.md`。

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

## 安装兼容性

本次版本 `versionCode=2` / `versionName=0.2.0`。显示名改为 `bcorn`，包名仍为 `com.acorn.widget`，私有缓存仍为 `files/timetable.json`，本地 debug 签名沿用已有 keystore。覆盖安装同签名版本不主动清理缓存；安装时若系统提示签名冲突，不要卸载以免丢失未导出的数据。

小组件 bitmap 按显示密度绘制并限制为 480,000 个 RGB565 像素；窄小尺寸显示日程列表，较大网格中的窄重叠栏优先显示短课程代码与起止时间。资源初始态提供明确加载 / 打开应用提示；异常回退不会默默显示空白。
