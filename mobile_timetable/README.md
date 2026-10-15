# bcorn mobile · 今日课表

一个独立的 Flutter 移动端实验版：手动创建课表，把今日课程、正在上课和下一节带到手机桌面。

本目录保留在原 bcorn-widget 仓库内，**不修改原 Electron / macOS 应用**。原仓库里的 `flutter_app/lib/main.dart` 是计数器示例；这里建立了新的、可继续开发的移动端实现，而不是声称把 Electron 直接转换成手机应用。

## 现在有什么

- 中文优先的今日、一周、课程编辑和设置界面；首次打开为空课表，示例数据必须主动点击加载。
- 课程新增、修改、删除；每周重复，开始/结束时间，可选学期起止日期、备注、颜色。
- 本机持久化；JSON 复制备份与确认后导入替换；保存失败不覆盖原课表。
- 地点与地图链接分开保存：Google Maps、高德搜索链接生成，或自定义 HTTPS / 地图 App 链接。仅允许安全的网页/地图协议。单击课程只放大查看信息；长按课程或放大的详情 →「导航到上课地点」→ 选择地图/链接，才会打开外部服务。卡片与详情没有常驻导航按钮。
- Android 原生可调整大小、可滚动的今日课表桌面组件；当前/下一节提示，点击课程精确打开应用中的课程详情；无第三方原生依赖。
- iOS WidgetKit 的小/中/大桌面组件、iOS 16+ 下一节锁屏矩形组件**源代码与接入指南**。需要在 macOS/Xcode 创建 extension target 并配置签名和 App Groups 后构建。

## 重要边界

- 这是定时开发的 **0.1 实验版**，真实机型验收仍待完成。阅读 [验证记录](docs/VALIDATION.md)，区分已执行与未执行的检查。
- 此版本是手动课表，**未移植 ACORN 登录、自动抓取、成绩单或凭据保存**。无需登录；不要把学校密码放进课表。
- Android 可接近铺满独立桌面页；launcher 网格、系统边距、底部 dock 和状态栏不受 App 控制。vivo X200 Pro / OriginOS / Funtouch OS 的桌面操作与省电策略需要真机确认。
- **不保证 vivo 息屏 AOD 支持任意第三方课表**，也未实现通知或 Live Activity。iOS 锁屏组件受系统、机型、锁屏配置及隐私设置限制。
- 桌面组件由系统调度更新，不保证整点/分钟精确；应用前台每 30 秒更新当前/下一节。Android 使用 30 分钟周期与尽力而为的边界刷新；iOS 使用预计算时间线。
- 同时上课的课程均保留。主卡片显示排序后的第一门，并提示重叠数量。跨夜课程请拆分为两条。
- 所有时间按设备本地时间解释；旅行切换时区会改变课表时间所代表的实际时刻。

## 交互

应用内：单击课程 → 放大信息；长按课程或详情 → 扩展操作菜单，目前仅有「导航到上课地点」；编辑入口在详情右上角，删除在编辑页底部并需确认。

桌面组件：单击课程 → 同一门课的应用详情，再长按详情。Android/iOS 桌面组件长按由系统用于移动/编辑，不承诺与应用内手势相同。

## Android 构建

准备官方 Flutter SDK（本次验证目标 3.47.7 / Dart 3.13.5）、JDK 21、Android SDK 36（最低运行 Android 7.0 / API 24）；Gradle 8.14.3、AGP 8.11.1、Kotlin 2.2.20 已配置；接受 Android SDK 许可。当前 Gradle 配置见 `android/`。

```sh
cd mobile_timetable
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

Android ARM64 测试包可使用 `flutter build apk --release --target-platform android-arm64` 构建；当前 release 配置仍使用 debug key，仅用于个人测试。

调试 APK：`build/app/outputs/flutter-apk/app-debug.apk`。这是开发调试签名，不是商店发布包。发布前请自行设置 release signing、唯一 applicationId 和版本号，勿提交 keystore、密钥或 `local.properties`。

连接 Android 设备后运行 `flutter run`。组件需要把 App 安装到真实支持的 launcher；普通 Flutter 页面测试不能证明桌面组件实际可用。

更多说明和 vivo 添加步骤：[Android README](android/README.md)。

## iOS 构建

必须使用 macOS、Xcode、Apple 签名配置。不要在 Linux 上把提供 Swift 文件误认为已编译的 iOS App。

按 [iOS README](ios/README.md) 操作：准备 Flutter Runner，安装 Swift bridge，共享模型加入 Runner 和 Widget Extension 两个 target，统一 App Group，添加 WidgetKit extension，设置 entitlement 和部署版本，然后在 Xcode 中构建运行。辅助脚本的执行范围以该文档为准。

## 数据与扩展点

[模块设计说明](docs/ARCHITECTURE.md)

- `lib/timetable.dart`：独立 Dart 课程模型、校验、日期/当前/下一节逻辑、JSON。
- `lib/main.dart`：应用入口、页面状态与用户操作协调。
- `lib/course_editor.dart`：课程编辑与表单校验。
- `lib/course_details.dart`：只读放大详情、可扩展长按菜单、导航选择器。
- `lib/schedule_components.dart`：日程卡片与当前/下一节展示。
- `lib/app_theme.dart`：共享视觉常量。
- `lib/platform_store.dart`：唯一平台接口 `io.bcorn.mobile/timetable`。
- `android/`：原生持久化、AppWidget、链接打开与刷新。
- `ios/`：App Group 持久化、Flutter bridge、WidgetKit time line。
- [共享数据协议](docs/DATA_CONTRACT.md)：各平台都读取同一份 v1 JSON。

下一步可在保持 v1 数据协议兼容的情况下增加 ICS 导入、课程单双周、多个课表、课程提醒和有明确授权的 ACORN 连接。当前版本没有这些能力。

## 隐私与来源

课表保存在本机与平台 widget 容器。应用没有课程上传或账号系统；地图链接会由浏览器/地图应用接收目的地。系统备份和锁屏展示取决于系统设置。

来源与许可限制见 [PROVENANCE.md](PROVENANCE.md)。原项目未见 LICENSE；本模块主要为新写代码，并按用户要求提交到其 fork 的独立分支。发布 fork 不等于获得原作者额外许可；不应据此推断具有再发行原仓库其他代码的许可。
