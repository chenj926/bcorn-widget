# 验证记录 · 2026-10-15

本记录区分实际执行结果与尚未验证的环境。实验版不等于已完成真机验收。

## 已通过

- 官方 Flutter 3.47.7 / Dart 3.13.5 SDK 在 Linux 安装并运行。SDK 压缩包校验 SHA-256。
- `flutter analyze --no-pub`：No issues found（最终源代码）。
- `flutter test --no-pub`：18 个测试全部通过；默认跳过 1 个仅用于截图的测试。
  - 11 个领域测试：开始/结束边界、学期日期、重叠课程、下一节、午夜、异常输入、JSON 往返、不可变编辑/删除、链接协议与转义。
  - 7 个真实 Flutter 页面测试：新增/保存/编辑取消/重载；读取失败；保存失败；空名称和显式示例；单击详情/长按菜单/明确导航选择；组件冷启动精确课程跳转；删除确认与持久化。
- `flutter test --no-pub test/preview_test.dart --dart-define=GENERATE_PREVIEW=true`：1 个测试通过；实际 Flutter 渲染出首页和课程详情 PNG。
- `dart tools/verify_model.dart`：21 个无需 Flutter 的纯 Dart 检查通过。
- Android 7 个实际 Kotlin 源文件使用 Kotlin 2.2.20、真实 Android 36 与官方 Flutter/AndroidX 编译通过；10 个原生 JVM 领域测试通过；完整 Gradle `:app:testDebugUnitTest` 也通过（10 tests / 0 failures / 0 errors）。
- Android aapt2 编译并链接全部资源和 AndroidManifest。
- 完整 Android debug APK 构建成功；签名验证通过（APK signature scheme v2）。
- 完整 ARM64 release-mode APK 构建成功；约 18.5 MB，使用开发调试签名，适合个人测试，不是生产发布签名。
- iOS 6 个 plist / entitlements / privacy manifest XML 验证；App Group、scene 配置、MethodChannel 名称一致；bootstrap 脚本 shell 语法通过。

## 本次构建环境

- Flutter 3.47.7 / Dart 3.13.5
- JDK 21.0.12.1
- Gradle 8.14.3 / Android Gradle Plugin 8.11.1 / Kotlin 2.2.20
- Android targetSdk 36 / minSdk 24（Android 7.0）；安装包 package `io.bcorn.mobile`，版本 `0.1.0+1`
- ARM64 包适合 Vivo X200 Pro 等 arm64-v8a 手机；不能装在仅 x86 的模拟器上。
- Release manifest 无 INTERNET 权限；打开外部地图仍由系统交给对应应用处理。

首页和放大课程详情截图作为交付附件提供；也可运行截图测试重新生成 `docs/preview-today.png` 与 `docs/preview-detail.png`。它们来自 Flutter 页面测试渲染，采用明确标记的虚构示例课表与 Noto CJK 字体；不是 Vivo 真机、Android launcher 或 iOS WidgetKit 的运行截图。

最终 ARM64 APK 已在代码冻结后重新构建并验证签名，文件名 `app-release.apk`，18,504,804 字节。SHA-256：

```
5327b14297a9ea829c6c92987247b9f6ffa118580e3581d6c1a1b0743917f8e3
```

## 没有验证，不能据此宣称已完成

- 没有连接 Android 真机或可用 Android 模拟器。未实际安装、启动 APK，也未操作 vivo X200 Pro 桌面组件。
- Android launcher 的全页拉伸、滚动、进程被杀后的恢复、重启广播、省电延迟和组件点击冷/热启动仍需设备验收。Dart 层冷启动路由已测试，但原生→Dart→设备的全链路未真机验证。
- 没有 macOS / Xcode / Swift 编译器，未编译 iOS host/extension、执行 Swift 模型测试、执行 Ruby Xcode target 集成脚本、签名、安装或测试锁屏。iOS 提供的是实现源文件和接入步骤。
- 没有 ACORN 自动导入、学校登录、通知提醒、Live Activity、vivo 私有 AOD API 或单双周排课。
- 原生组件长按由系统/launcher处理；不能宣称支持应用内的自定义长按菜单。组件点击先进入 App 详情，再长按详情导航。

## 真机验收最短路径

1. 安装 ARM64 APK，首次打开为空课表；添加今天一门课，设置时间、地点和地图链接。
2. 关闭并重开 App，确认课表仍在；单击课程只显示详情，没有自动跳地图。
3. 长按课程或详情 →「导航到上课地点」→ Google/高德/已保存链接。检查取消菜单不打开地图，重复进入不叠加误操作。
4. 编辑、删除，取消删除；确认保存失败的提示不会误报成功（可在测试设备模拟存储故障）。
5. 加入桌面组件，单独一页拉伸并滚动；点具体课程，检查打开的是同一门课详情；更改课表后检查刷新。
6. 跨课程边界、跨午夜、跨时区和重启后检查；理解省电模式可能延迟组件刷新。
7. iOS 按独立指南在 macOS 配置，分别验收 Home Screen、Lock Screen、App Group 与冷启动链接。
