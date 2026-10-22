# bcorn Android 原生外壳与桌面课表

Kotlin / Android SDK 应用，最低 API 26、目标 API 35。系统 WebView 继续显示共享的 `src/renderer` / `src/shared`，不是另写的替代界面。构建只复制这些公开代码；`mock.js` 不进入 APK。安装包名为 `com.bcorn.widget`，与旧版 `com.acorn.widget` 并存；Kotlin / 资源 namespace 仍为 `com.acorn.widget`。`files/timetable.json` 相对路径不变，但位于新版独立的 Android 私有沙箱，不能自动读取旧版数据。

## 桌面小组件

- 真实 `AppWidgetProvider` / `RemoteViews`。48dp 的上一段、今天、日/周切换、下一段按钮是显式、不可变的原生广播 PendingIntent，点击不启动 WebView。日视图前后移动一天，周视图移动七天。
- 每个小组件独立原子保存日/周模式和浏览日期。切换模式保留日期；未浏览时跟随今天，“今天”恢复跟随且保留模式。调整大小、重新实例化 provider、应用进程回收不依赖内存状态；旧版周一日期自动兼容，删除小组件清理对应状态。
- 点按课表打开应用并携带当前模式及具体日期（同时保留旧版 weekStart 参数），不会把浏览日期的用户带回旧日期。桌面长按仍是启动器的移动 / 调整大小操作。
- 建议 5×7，实际单元格由启动器决定。日视图以课号（课程内日程可附短标题）为主标题，完整课程名仅在详情显示，紧接醒目教室，并单列起止时间展示选中日，溢出数量明确提示。周视图正常尺寸显示周一至周日；窄小尺寸显示七天摘要，极矮内容区显示七天日期及事项数，不会因周一忙碌而完全隐藏周末。周课块同时显示课程代码和教室；长教室名称最多分两行，保留末尾房间编号；真正短时段课块保持时间几何，用局部适配的课程/房间简写，完整教室和时间仍在无障碍描述及日视图中。宽度 160–203dp 使用两行 48dp 控件，204dp 起使用单行，最小尺寸仍可切换模式。
- 导航控件至少 48dp；常规课表不显示重复标题和时区页脚。教室使用更醒目的首行，课程代码为次要文字；教室缺失才使用地点。重叠事件并排，候补有虚线与文字，TBA 不制造时间块。
- 支持自定义课程 / 事项颜色、跨时区与跨午夜分段、排除日、课内单次事项（可在教学期之外）。假期仅用浅色背景提示，不自动取消课时。
- Launcher 持有最后一份 RemoteViews。原生导航只读本地缓存，没有服务、保活或组件后台联网。Android 系统每日批量重绘可能受休眠 / OEM 限制，不保证午夜即时更新；浏览中的绝对日期不会被每日更新重置。系统“强行停止”可能阻止更新，不能等同于普通进程回收。
- bitmap 按显示密度绘制，限制为 480,000 个 RGB565 像素，低于 1 MiB。加载 / 损坏缓存有明确空态。

## 应用与本地数据

- 原生 FrameLayout 根容器处理系统栏、刘海、横屏侧栏和 IME insets；WebView 本身不以 padding 假装缩小 HTML viewport。重复 inset 分发不会累加空白。
- 返回先交给共享界面关闭菜单 / 编辑 / 详情，保留未保存确认；根页面两秒内再按一次返回桌面。Android 13+ 使用原生返回回调。
- JSON 导入经过共享校验、预览和确认，私有缓存 AtomicFile 原子保存。JSON / ICS 由系统文件选择器导出。
- 个人成绩册是独立的 `files/grades-v1.json`，严格白名单、版本 / 大小 / ID / 分数校验，原子写入。清除课表与导入的历史成绩不会删除个人成绩册。
- 课表、个人成绩册、组件浏览状态、系统日历关联都不参加系统备份或设备迁移。无应用级课表加密；依赖 Android 沙箱及设备存储保护。
- Android ACORN 登录 / 刷新尚未迁移。不得把本地保存或系统日历写入称作 ACORN 同步成功。

## 可选系统日历联动

只有在用户明确启用时请求 READ_CALENDAR / WRITE_CALENDAR，再选择实际可写的系统日历。提供者可能是本机、Google、Outlook / Exchange 或 OEM 账户，取决于设备实际暴露的 CalendarProvider；不能据应用已安装就宣称可用或云端送达。

联动使用稳定本地 ID 和私有绑定日志，重复保存不新建重复事件，更改提醒更新原记录，移除只触碰本应用拥有的记录。已有绑定时切换目标先拒绝，明确解除后才能改选。权限撤回、日历删除或失败时本地数据保留。应用进程内使用一个串行写入器，不跑轮询。完整协议与限制见 [`docs/android-calendar.md`](../docs/android-calendar.md)。

原有“在系统日历预览”仍使用 ACTION_INSERT，必须由用户保存，返回仅 `opened: true, saved: false`。它不会在联动失败后被自动调用。

## 构建

需要官方 JDK 17+、Android SDK Platform 35 / Build Tools 35.0.0、Gradle 8.13（Kotlin 2.0.21）。使用已接受许可的官方工具；脚本不会下载或接受许可。

```sh
export ANDROID_HOME=/path/to/android-sdk
export GRADLE_HOME=/path/to/gradle-8.13
./scripts/build-offline.sh --unsigned
```

输出 `app/build/offline/acorn-android-unsigned.apk`。这是编译 / 测试产物，不能当作可安装升级包。首次需用常规 Gradle 恢复官方 Google AuthorizationClient 和 OkHttp 依赖；离线脚本再调用 AGP 的 `--offline` 构建，确保合并依赖 AAR 的资源与清单，而非手工拼装不完整 APK。

当前环境已丢失旧 debug key，构建不生成新签名。不要为了安装新签名包卸载旧应用，否则可能丢失私有数据。debug 默认不签名，避免 AGP 自动生成不同身份的密钥；并存版必须使用另行批准、妥善保存的新签名身份；之后的新版更新必须沿用它。

安装交付候选使用非调试 release 构建（Android 版本 `0.3.2` / code `5`）：

```sh
"$GRADLE_HOME/bin/gradle" -p android :app:assembleRelease --offline --no-daemon
```

从仓库根目录运行，然后检查真实合并清单（含依赖提供者 authority）：

```sh
python3 android/scripts/check-release-identity.py android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml
```

产物为 `android/app/build/outputs/apk/release/app-release-unsigned.apk`，`debuggable=false`，仍须经批准的签名流程处理后才能安装。debug 无签名构建保留给现有 Robolectric host 测试，不能替代最终 release 包验证。

## 与旧版并存及数据迁移

- 保留旧版应用。在旧版选择“备份全部数据…”导出 JSON，再在新版导入，先检查预览再确认。若旧版只支持课表 JSON，仍可导入课表；没有包含在文件中的偏好与成绩不会凭空恢复。
- 新版不覆盖、删除或直接读取旧版私有目录，也不申请共享 UID。课表、成绩册、WebView 数据、组件浏览状态、日历绑定日志和 Android Keystore 均随新版应用身份隔离。
- 新版需重新添加桌面组件；旧组件仍属于旧版。新版日历联动默认关闭，请勿让两版同时联动到同一系统日历，以免重复事件。
- 显式组件保留代码 namespace，RemoteViews 使用当前运行包名；组件导航广播与 URI 使用新版身份。源清单没有自定义 ContentProvider authority 或外部 deep-link 入口；依赖清单仍须通过最终合并清单检查。
- Google 成绩同步默认未启用；新包名和新签名证书必须单独注册 Android OAuth client 后才能启用。

## 可选 Google 成绩表

授权与 HTTP 请求由原生模块承担，WebView 不收到 OAuth token。仅申请 `drive.file`，支持新建独立成绩表或由用户使用 Picker 选择现有测试表。应用前台自动检查轻量版本元数据，变化才读取表格；退到后台停止调度，下次打开自动追平。没有常驻同步服务。需要先配置真实 Google 项目及匹配包名和签名的 Android OAuth client；未配置时明确显示本机保存，不能宣称云同步可用。当前构建配置默认未连接，未进行真实授权。

## 检查

```sh
node tests/bridge.test.cjs
node --test tests/package-identity.test.cjs
# 官方 host 依赖准备与两次独立 JVM 验证见 tests/native-host/README.md
./tests/native-host/run.sh
```

真实生产 provider、RemoteViews apply/reapply、点击广播、CalendarProvider adapter、Activity JS 接口链均有合成 host 测试。原生根容器几何使用普通子 View 验证，因为 Robolectric 的 WebView provider 不实现真实 Chromium 布局。合成 PNG 在忽略的 build 目录。

没有 Vivo 真机或模拟器验证。安装 / 升级、真实启动器、系统键盘 / WebView、账户云同步与提醒送达仍需设备验收；见 [`TESTING.md`](TESTING.md)。

### 0.3.2 Google 授权入口的显式构建开关

默认仍未启用。只有在为自己的 Google 项目准备测试版时，使用 `:app:assembleRelease -PbcornGradeSyncConfigured=true`；其他值（除 true/false）会失败。此开关只设置 manifest，不替你完成 Google 注册。验证启用版清单时，给 `check-release-identity.py` 加 `--expect-grade-sync true`。保持同一 keystore，版本已增为 0.3.2 / code 5。详见 `docs/GRADES_SYNC.md`。
