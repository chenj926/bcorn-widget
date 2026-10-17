# ACORN Widget

U of T ACORN 的桌面小组件，只显示三样东西：**今天的课**、**每学期课表**、**成绩单**。

## 安装

```bash
npm install
npm run package:install
```

这一步会打包出 `ACORN Widget.app`（本机自用的 ad-hoc 签名），并安装到 `/Applications`。如果旧版本正在运行，会先把它退出。之后在启动台或 Spotlight 里双击就能打开。

- **开机自启**：打包版第一次启动时会自动登记为登录项。要关掉，可以在菜单里取消「开机自启」，也可以去「系统设置 → 通用 → 登录项」里关。
- 只打包、不安装：`npm run package`，产物在 `dist/` 里。

小组件隐藏了或者被别的窗口挡住时，有三种方法找回来：
- 点 **Dock 图标**（或者在应用程序文件夹里再双击一次），小组件会显示出来并放到最前面。
- 点**菜单栏的日历图标**：被挡住时是拿到最前面，已经在最前面时是隐藏。右键这个图标会打开菜单。
- 小组件右上角的「⋯」也是同一个菜单：置顶、开机自启、刷新、重新登录、退出登录并清除数据。

开发时用 `npm start` 直接运行源码。开发版和安装版共用同一个数据目录，同一时间只能运行其中一个，所以开发前先从菜单里退出安装版。

## 登录是怎么回事

- 登录窗口里加载的是 UofT 官方登录页，密码和 MFA 都在那个页面里输入，应用本身不碰也不存密码。
- 登录成功后，应用沿用这个窗口的会话（cookie），去请求 ACORN 网页自己用的接口。
- **重启不掉线**：UofT 发的登录 cookie 都是会话级的，普通 Electron 应用一退出就没了。本应用学 Chrome「继续浏览上次打开的网页」的做法，把它们存到磁盘（Chromium 用钥匙串加密），所以退出、重启、开机后还能接着用。服务器那边的会话到期了照样需要重新登录。
- **保活**：应用运行时每 10 分钟发一个很轻的请求，合盖唤醒后也会马上检查一次，免得会话因为闲置过期。ACORN 会话掉了，会先在后台静默走一遍 SSO：UofT 登录服务器的会话还有效时，不需要你做任何事；需要密码或 MFA 时，底栏会出现「重新登录」。
- **会话日志**：`~/Library/Application Support/ACORN Widget/session.log` 只记录时间和事件名（启动、登录、刷新成功、静默续登成功或失败），不含课表和成绩。用它可以看出 UofT 的会话实际能撑多久。
- 上次拉到的数据会缓存下来，用 macOS 钥匙串加密存放在 `~/Library/Application Support/ACORN Widget/cache.bin`，所以没登录时也能看。

## 数据来源（ACORN 内部接口，只读）

| 内容 | 接口 |
| --- | --- |
| 已选课程、学分 | `/sws/rest/enrolment/eligible-registrations`、`/sws/rest/enrolment/course/enrolled-courses` |
| 上课时间 | `/sws/rest/timetable/export-iCalEvents`（Timetable & Exams 页的「导出日历」，带真实日期和停课日） |
| 成绩单 | `/sws/rest/history/academic/complete`（Academic History 页的完整版） |

这些接口没有官方文档，ACORN 改版时可能会失效，到时改 [src/acorn.js](src/acorn.js) 就行。ACORN 对频繁请求有验证码限制，所以应用默认每 3 小时才自动刷新一次。

## 开发

- `npm run debug`：开启调试日志和 Chrome 远程调试端口（9229），登录窗口登录后不会自动关闭。**调试端口能访问你的 ACORN 会话，只在开发时用。**
- 在普通浏览器里打开 `src/renderer/index.html`（需要通过本地服务器访问，比如 `python3 -m http.server -d src/renderer`），会用 [mock.js](src/renderer/mock.js) 里的假数据预览界面。
- `npm run icon`：重新生成菜单栏图标和应用图标（[assets/](assets/)）。
- 改完代码后重新运行 `npm run package:install`，安装版才会更新。

## 文件

- [src/main.js](src/main.js)：主进程，负责窗口、Dock 和菜单栏、登录、会话保持和加密缓存
- [src/acorn.js](src/acorn.js)：请求 ACORN，解析 iCal 和成绩单
- [src/renderer/](src/renderer/)：小组件界面
