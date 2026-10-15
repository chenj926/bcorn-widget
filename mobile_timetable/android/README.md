# Android / Vivo X200 Pro 桌面课表

这部分提供 Flutter 的 Android 宿主和真正的 Android AppWidget。它不是网页截图，也不需要后台常驻服务。应用和小组件读取同一份本地课表。

## 在 Vivo 上使用

1. 安装构建出的 APK，先打开「今日课表」，录入或导入课程并保存。
2. 在应用内点「添加桌面小组件」。如果系统支持固定请求，会出现桌面确认；返回成功只代表请求被桌面接收，并不表示已放置。
3. 如果没有出现确认，回到桌面，长按空白处，进入系统的「组件 / 小组件」选择器，寻找「bcorn · 今日课表」。OriginOS 的菜单名称会随版本变化。
4. 默认尺寸为 4 × 5 格。建议另建一个空白桌面页面，把组件拖入，再长按组件拖动边框，铺满桌面可用区域。横向和纵向都可调整；最小约 180 × 250 dp。实际最大尺寸、网格和留白由 Vivo 桌面决定。
5. 当课程超出屏幕时，在组件课程列表区域上下滑动；点击标题进入应用编辑，点击课程或焦点卡片进入应用内放大的课程详情；在应用内长按课程信息，展开菜单后选择「导航到上课地点」才打开地图/网页。
6. 更改课程后保存，所有桌面组件都会刷新。也可点组件右上方的「刷新 ↻」。

桌面组件上的长按由系统桌面保留，用于移动、拉伸或移除组件，不能可靠替换为课程菜单。先点组件课程进入应用，再长按放大的课程信息，即可打开可扩展菜单；目前菜单只有「导航到上课地点」。课程卡片和详情不常驻显示导航按钮。

“整页”指主屏的一整个可用网格区域，不能覆盖状态栏、手势区、桌面固定栏等系统区域。AppWidget 不等于锁屏组件、OriginOS 原子组件或熄屏显示（AOD）；这里没有承诺 AOD/锁屏可用，也没有接入 Vivo 私有桌面组件协议。尚未在实体 Vivo X200 Pro 上验证桌面网格、点击跳转或电池策略。

## 显示规则

- 按设备当前本地日期、星期和时区筛选。周一=1，周日=7。
- 日期范围的首尾日期都包含在内。没有范围时按星期每周重复。
- 当前课程：startMinutes ≤ 当前分钟 < endMinutes；下一节：今天尚未开始的第一节。
- 重叠课程全部保留，焦点卡片提示重叠数量，完整列表能看到每一节。
- 课程按开始时间、课程名称排序；上完的课程仍在全天列表中。
- 没有课程时显示空状态，不会偷偷写入演示数据。
- 数据异常时保留原始本地数据，提示打开应用检查，不会静默重置。
- 为避免系统 Binder 传输上限，小组件最多显示当天前 60 节并附显式“还有 N 节”入口；完整数据在应用内，原数据不删减。

## 更新频率与电量

Android 的 AppWidget 周期更新最短为 30 分钟，因此 XML 配置为 1,800,000 ms。保存课程、打开应用、手动刷新、设备日期/时间/时区变化、重启和应用更新也会触发更新。

另有一个普通、非唤醒的 `AlarmManager.RTC` **非精确**闹钟，目标为下一次课程开始/结束或本地午夜。它不要求精确闹钟权限、不申请电池优化白名单，也不会为了刷课表唤醒休眠设备。系统可能合并或推迟该闹钟；省电模式、待机和 OriginOS 后台策略都可能进一步延迟更新。当前/下一节状态不是秒级或分钟级准确保证，底部显示本次渲染时间和“可能延迟”。真正上课提醒应由用户单独设置系统闹钟。

无需通知、定位、联系人或外部存储权限。课程只存放在应用私有 SharedPreferences；没有服务端、追踪器或自动云同步。系统备份默认关闭。点地图/网页链接会把课程中配置的 URL 交给相应外部应用，地点由用户填写。

## Flutter MethodChannel

Channel: `io.bcorn.mobile/timetable`

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `load` | 无 | 持久化 JSON 字符串，首次运行返回 null |
| `save` | `{ "json": "…" }` | 校验并持久化成功返回 true，随后尝试刷新所有组件；失败为 PlatformException |
| `openUrl` | `{ "url": "…" }` | 成功启动外部应用为 true，无处理程序为 false，不允许的 URL 为 PlatformException |
| `requestPinWidget` | 无 | Android 8+ 桌面接受固定请求为 true；不支持返回 false |
| `getPlatformInfo` | 无 | Android 版本、厂商、型号字符串 |
| `getPendingCourseId` | 无 | 返回并清空待打开的课程 ID，没有则 null |

组件点击时，冷启动会保留课程 ID，Flutter 加载课表后调用 `getPendingCourseId` 消费。热启动由 `onNewIntent` 排队，并主动调用 Dart 侧 `courseLinkAvailable`；Dart 收到后再调用 getter。课程详情确认存在才展示，已删除课程安全回到首页。

私有 SharedPreferences 文件：`bcorn_timetable`；键：`timetable_json`。没有第二份不同步的 Flutter 偏好数据。JSON contract：

```json
{
  "version": 1,
  "updatedAt": "2026-10-15T05:00:00.000Z",
  "courses": [
    {
      "id": "user-generated-unique-id",
      "title": "用户填写的课程",
      "weekday": 4,
      "startMinutes": 540,
      "endMinutes": 630,
      "location": "用户填写的地点",
      "mapUrl": "",
      "notes": "",
      "color": 4282948208,
      "startDate": null,
      "endDate": null
    }
  ]
}
```

上述内容仅说明格式，不在运行时插入。时间范围 00:00–24:00，结束必须晚于开始，不支持跨午夜课程。日期采用 `YYYY-MM-DD` 或 null。快照最大 1,000,000 字节、500 节课程，所有 ID 必须非空且唯一。

## 链接与 PendingIntent 安全

允许 `http`、`https`、`geo`、`google.navigation`、`amapuri`、`androidamap`、`iosamap`、`maps`。网页 URL 必须有主机且不能包含用户名/密码；控制字符、空 scheme、`file:`、`javascript:`、`intent:`、任意其他 scheme 一律拒绝。不解析 Intent URI，不允许课程提供 package/component/extras。不会因地图未安装而猜测或改写目的地。

只有课程列表模板 PendingIntent 因系统行点击机制要求可变，而且目标为明确、未导出的 `WidgetLinkActivity`。行只传课程 ID；Activity 每次从私有快照核实课程，再把 ID 交给 Flutter 打开详情，不自动导航到外部地图。其他 PendingIntent 不可变。RemoteViewsService 受 `BIND_REMOTEVIEWS` 保护。跳转通过 Activity 直接发起，不使用后台广播启动 Activity 的 trampoline。

## 构建

需要 Flutter SDK、Android SDK 和 JDK 17 或兼容版本。当前 Gradle 配置：AGP 8.11.1、Gradle 8.14.3、Kotlin 2.2.20，compileSdk/targetSdk/NDK 跟随 Flutter，最低 API 为 max(23, Flutter 最低 API)。`java.time` 通过官方 core library desugaring 支持旧版本。

从项目根目录运行：

```sh
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

Flutter 会更新本机 `android/local.properties`，不要提交本机 SDK 路径。Gradle Wrapper 来自 Flutter SDK 自带模板。正式发布前必须配置自己的上传签名；当前 release 沿用 debug 签名只为本地试用，不适合上架。

### 需要设备验证的清单

- 实体 Vivo X200 Pro / 当前 OriginOS：放置、整页拉伸、列表滚动、横竖尺寸变化。
- Android 12+ inline RemoteCollectionItems；Android 7–11 RemoteViewsService 回退（本次构建最低 API 24 / Android 7.0）。
- 当前/下一节的开始和结束边界、午夜、手动改时区、重启、待机恢复。
- 相同时间重叠课程、周日到周一、日期首尾、课程删除后点击旧行。
- 首次空数据、无课日、无下一节、61+ 节和损坏快照。
- 课程 `https://…`、`geo:…`、高德链接；无对应地图应用；恶意 scheme 被拒绝。
- 多个组件实例在保存/手动刷新后保持一致；取消固定请求不谎称安装完成。

## 官方参考

- [Android AppWidget 配置与 30 分钟限制](https://developer.android.com/reference/android/appwidget/AppWidgetProviderInfo)
- [Android collection widgets / RemoteCollectionItems](https://developer.android.com/develop/ui/views/appwidgets/collections)
- [Android widget 更新](https://developer.android.com/develop/ui/views/appwidgets/advanced)

## 本次验证记录

- Android 36 的 aapt2：全部资源编译和 Manifest 链接通过。
- Kotlin 2.2.20：七个真实原生源文件（包括 Flutter MainActivity）在 Android 36、官方 Flutter embedding 和 AndroidX Lifecycle classpath 下编译通过。
- 原生 JVM 模型测试：10/10 通过，使用 JUnit 4.13.2 和 org.json 20240303。
- 上述独立检查不等同于完整 APK 打包或实体桌面运行验证；最终 APK 构建结果见项目根交付说明。
