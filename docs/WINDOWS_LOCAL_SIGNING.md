# Windows 本地签名（bcorn 0.3.1）

此包是 `com.bcorn.widget` 的新身份，可与旧版 acorn 并行安装。未签名 APK 不能直接安装。密钥只在你的 Windows 电脑生成、保存；不要把密钥文件或密码发到聊天或上传。以后升级必须保留并复用同一密钥。

## 第一次准备

不需要 Python。需要 Windows PowerShell 5.1、完整 JDK 17+、Android SDK Build-Tools 35.0.0。

最省设置的方法：从 [Android 官方网站](https://developer.android.com/studio) 安装 Android Studio，自行阅读并接受相关条款；打开 SDK Manager → SDK Tools → Show Package Details，安装 Android SDK Build-Tools 35.0.0。默认安装位置时，脚本会识别 Android Studio 自带的 JBR 和 `%LOCALAPPDATA%\Android\Sdk`。

已有 JDK/SDK 时无需重装。脚本也识别 `JAVA_HOME`、`ANDROID_SDK_ROOT` / `ANDROID_HOME`。独立 JDK 可从 [Adoptium 官方安装页](https://adoptium.net/installation/windows/) 获取，选择 JDK 17 或更高，并配置 JAVA_HOME。自定义 Build-Tools 路径可在 PowerShell 运行：

```powershell
.\Sign-bcorn.ps1 -BuildToolsPath 'D:\Android\Sdk\build-tools\35.0.0'
```

脚本不会自动下载、安装工具、接受许可或修改执行策略。如果 Windows/组织安全策略阻止运行，请停止并让管理员检查文件与策略；不要绕过安全提示。双击入口并不保证所有电脑都能直接运行。

## 开始（工具准备好后）

1. 把交付 ZIP 完整解压到“下载”等普通文件夹。保持 `Start-signing.cmd`、`Sign-bcorn.ps1`、`release-metadata.json` 和未签名 APK 在一起。
2. 双击 `Start-signing.cmd`。先核验 APK 的 SHA-256、包名、版本与非调试标志；失败就停止。
3. 输入密钥备份文件夹的完整路径，例如 `E:\bcorn-key-backup`。建议使用独立 NTFS 移动硬盘上的专用文件夹。不要选择整个盘根目录或其他文件所在目录。脚本仅为新建专用文件夹限制访问权限；已有共享/宽松权限文件夹会拒绝使用，不会修改其权限；不支持 Windows ACL 的文件系统会停止。
4. 首次创建时输入 `CREATE`；按本机 keytool 的提示设置密码，再在签名工具提示时输入。密码不进入脚本参数、环境变量或日志。请使用密码管理器保存强密码（建议长随机 ASCII 字符，避免跨工具编码差异），不要开启录屏或终端记录。
5. 看到 `SUCCESS` 后，在“文档\bcorn-releases”取出已签名 APK，自行传到手机安装。不会自动发送或上传。并行新安装不会自动继承旧 app 的数据、权限或桌面组件。

密钥位于 `%LOCALAPPDATA%\bcorn-signing\bcorn-release.p12`，备份位于你选择的目录。脚本验证两份文件不同且字节一致；这不证明备份介质可靠或永久保存。相同盘符/文件系统会警告；不同盘符也可能位于同一物理硬盘。请确认备份确实独立，并妥善保管密码。

已有密钥会复用，已有不同备份绝不覆盖。只有备份、主密钥缺失时也会停止：应在本机恢复原密钥，不要新建身份。失败后可修正问题重新运行；已创建密钥会保留，未验证 APK 不会发布。断电/强制关窗可能留下私有暂存文件，请在确认没有签名进程运行后清理 `work-*` 或 `.staging-*`，不要删除 `.p12`。

## 交付与验证边界

交付元数据须由已验证构建填写真实 SHA-256（不能使用占位值）：

```json
{"apk":"bcorn-0.3.1-unsigned.apk","sha256":"真实的64位SHA256","package":"com.bcorn.widget","versionName":"0.3.1","versionCode":4}
```

SHA-256 防止意外损坏，不替代交付来源真实性检查。仅运行你信任来源的整个交付包。文件中不包含密钥、密码、JDK 或 Android 工具二进制。

本地仅检查 APK、不创建签名目录或密钥：

```powershell
.\Sign-bcorn.ps1 -ValidateOnly
```

开发者可运行 `node --test android/tests/windows-signing-handoff.test.cjs` 检查源代码约束；Windows 上还可运行 `android/tests/check-windows-signing-parser.ps1` 做解析检查（不执行签名）。这些测试不等于真实 Windows 签名验证。目前未在 Windows 终端实际完成交互签名；不得宣称已验证双击/密码提示/ACL 的运行表现。

工具行为参考：[apksigner](https://developer.android.com/tools/apksigner)、[sdkmanager](https://developer.android.com/tools/sdkmanager)。
