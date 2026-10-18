# Android 验证记录与设备验收

## 本次原生验证（2026-10-18）

- 0.3.1 已恢复官方 Platform 35、Build Tools 35.0.0、Gradle 8.13；完整 AGP debug/release 构建通过。160 项合成 host 测试在两个独立 JVM 中全部通过，使用实际 AGP APK/类/资源；合并 release manifest 与包名/版本验证通过。release 明确未签名；未生成云端密钥，真实 Windows 本地签名与 Vivo 并存迁移尚未验证。详见 `docs/VERIFICATION_0.3.1.md`。
- Node JavaScript bridge 契约通过。声明的系统日历权限仅在显式 UI 请求后触发；应用清单声明 INTERNET 用于显式连接后的前台成绩同步，不申请 Alarm 权限；官方 GMS 依赖含受保护的授权 callback 组件，最终清单须独立审计，不宣称零 service。
- Robolectric 4.14.1 + API35 使用实际生产 JVM classes、二进制资源、RemoteViews 与原生 Canvas。完整用例在两个独立 JVM 中执行（当前实际通过数量以 `tests/native-host/build/results-*.txt` 为准；新写用例及旧生产构建结果不能等同于当前源码已通过）。
- 20 个 widget / cache 用例：真实 RemoteViews.apply/reapply、实际 PendingIntent 广播队列、日/周切换与前后移动一天/七天 / 今天保留模式、两个组件互不干扰、四个互不重叠的 48dp 触点、160 / 180 / 203 / 204 / 260 / 350 / 500dp 尺寸、横屏、旋转重建、删除 / restore ID、两次独立 JVM 重读磁盘缓存及日/周模式、具体日期、跟随今天状态，旧周状态迁移、恢复时 ID 交叠、RGB565 内存上限、损坏 / 空缓存、候补 / TBA、七天含周末、单次 / 排除日、跨时区 / 午夜、DST、教学期外事项、自定义颜色与假期不取消课时。
- 8 个 Activity 返回策略用例，4 个组件日期 / 模式 deep-link 用例，1 个根容器 inset 用例：系统栏 / 刘海 / IME / 横屏侧栏 / 重复分发。WebView dummy provider 不实现真实 setFrame；几何断言验证同根容器的普通 match-parent 子 View，不能据此宣称 Chromium / Vivo 上无遮挡。
- 5 个个人成绩册存储用例：独立保存 / 读取、课表清除不删成绩册、未知版本 / 非白名单字段 / 重复 ID / 错误分数拒绝且不覆盖旧数据、2MiB 限制、AtomicFile 备份恢复。
- 18 个日历 facade 与 6 个实际 ContentResolver adapter 用例，另 1 个 Activity 集成用例：真实 JavaScript interface → MainActivity → 串行 gateway → CalendarProvider → 合成 in-memory provider。覆盖拒绝权限后本地保存、明确选择、保存两次幂等、更改提醒保持原事件 ID、其他事项不变、Activity 重建、撤权 / 日历移除结构化失败、无自动 ACTION_INSERT 回退。不会读取或修改真实账户。
- 合成 PNG 已逐张重点查看正常 5×7、七天 / 周末与小尺寸；没有复制用户截图或真实课程到仓库。Picker 预览标注“示例”。

## 当前限制

没有 Android 设备 / 模拟器。上述 host 测试不证明 Vivo launcher、真实 Android WebView、Google / Outlook 账户同步、提醒通知、系统重启调度、签名升级、文件选择器或键盘手势兼容性。当前只证明原生代码与 Android host 测试边界内的行为。

## 手机验收（仍待执行）

1. 当前 0.3.1 使用新包名 `com.bcorn.widget` 并存安装。先在旧版 `com.acorn.widget` 导出最新完整备份，再在新版预览并导入；逐项核对地址、地点、状态、排除日期与成绩。保留旧版，不卸载、不清除数据。签名必须在用户持久环境完成，见 `docs/ANDROID_PARALLEL_INSTALL.md`。
2. 空态无演示课表；导入合成 JSON 的预览取消不写数据，确认后才替换。无效 / 超过 2MiB 输入保留已有数据。取消文件选择器不应提示成功。
3. 顶部状态栏、刘海、横屏导航栏与键盘不遮住内容；键盘收起后底部空白恢复；输入 / 返回先处理编辑与未保存确认。
4. 添加两个小组件，分别切换日/周模式并浏览不同日期。日视图前后一天，周视图前后七天；切换模式保留日期，点课表进入对应模式及日期。缩放、旋转、普通杀进程再操作仍正确；今天只重置当前组件日期且保留模式。长按保留 launcher 调整大小。
5. 5×7 与最小尺寸均能发现周六 / 周日事项，日视图教室和时间清楚，极小尺寸显示溢出数、候补有标记，教学期外单次事项不被漏掉。假期背景不自动取消课时。
6. 系统日历联动：分别拒绝、部分拒绝、永久拒绝、允许、系统撤回权限。所有情况下本地保存仍可用，不伪称云同步或提醒送达。
7. 列出设备实际可写日历并手选目标。重复保存仅一份，改时间 / 颜色 / 教室 / 提醒后原项更新；候补 / TBA 不误写。删除 / 迁移 / 移除账户后出现可理解错误，不覆盖其他记录。
8. 验证所选 Google / Outlook / OEM 日历自身是否实际同步；通知权限、免打扰、OEM 电池限制下的提醒由系统日历负责。bcorn 不额外安排重复通知。
9. 已有日历关联时切换目标应要求先明确解除；停用联动保留既有事项，显式解除只删除拥有的记录。手动 ACTION_INSERT 预览取消不应称作已保存。
10. 个人成绩册独立保存、重新打开仍在；取消修改不写入；课表清除不删个人成绩册。导出的文件不包含 token、日历 provider ID 或私有绑定日志。

未执行的设备项目不得称作通过。
