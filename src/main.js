const { app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, safeStorage, screen, shell, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const acorn = require('./acorn');

const DEBUG = !!process.env.ACORN_DEBUG;
const PARTITION = 'persist:acorn';
const REFRESH_EVERY_MS = 3 * 60 * 60 * 1000;
const KEEPALIVE_EVERY_MS = 10 * 60 * 1000;
const COOKIE_DAYS = 7;

let widget = null;
let loginWin = null;
let loginPromise = null;
let tray = null;
let refreshing = null;
let status = { state: 'idle' };
let state = { bounds: null, pinned: false, autoLaunchSet: false };

const file = (name) => path.join(app.getPath('userData'), name);
const acornSession = () => session.fromPartition(PARTITION);
const log = (...args) => DEBUG && console.log('[acorn]', ...args);

// ---- 持久化：窗口位置 + 加密缓存（课表/成绩只存在本机，用 Keychain 加密） ----

function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file('window-state.json'), 'utf8')) };
  } catch {}
}

function saveState() {
  fs.writeFileSync(file('window-state.json'), JSON.stringify(state));
}

function readCache() {
  try {
    const buf = fs.readFileSync(file('cache.bin'));
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function writeCache(data) {
  const json = JSON.stringify(data);
  fs.writeFileSync(file('cache.bin'), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
}

// ---- 登录状态保持 ----

// 只记时间和事件名，用来看 UofT 的会话实际能撑多久（不含任何课表或成绩内容）
function sessionLog(event) {
  log(event);
  try {
    const p = file('session.log');
    if (fs.existsSync(p) && fs.statSync(p).size > 64 * 1024) fs.renameSync(p, `${p}.old`);
    fs.appendFileSync(p, `${new Date().toISOString()} ${event}\n`);
  } catch {}
}

// ACORN 和 UofT 登录服务器发的都是"会话 cookie"，应用一退出就没了。像 Chrome 的"继续浏览上次打开的网页"
// 那样，把 utoronto.ca 下的会话 cookie 改存成带过期时间的 cookie（Chromium 用钥匙串加密存盘），重启后接着用。
// 服务器那边的会话照样会过期，到期还是要重新登录；这里只是不让"重启应用"本身把登录弄丢。
function persistAuthCookies() {
  const { cookies } = acornSession();
  cookies.on('changed', (_event, cookie, _cause, removed) => {
    const host = cookie.domain.replace(/^\./, '');
    if (removed || !cookie.session || !/(^|\.)utoronto\.ca$/.test(host)) return;
    cookies
      .set({
        url: `https://${host}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: Date.now() / 1000 + COOKIE_DAYS * 24 * 60 * 60,
      })
      .then(() => cookies.flushStore())
      .catch((err) => log('persist cookie failed:', cookie.name, err.message));
  });
}

// ---- 数据刷新 ----

function publish(payload) {
  if (payload.status) status = payload.status;
  widget?.webContents.send('acorn:update', payload);
}

// ACORN 的会话很短，但 UofT 登录服务器（IdP）的会话更长。ACORN 过期后先在隐藏窗口里
// 走一遍 SSO：IdP 会话还在就能直接拿到新的 ACORN 会话；要输密码或 MFA 时会卡在登录页，超时放弃。
function silentLogin(timeoutMs = 15000) {
  if (loginWin) return Promise.resolve(false);
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION } });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const check = async (_event, url) => {
      if (acorn.isAcornAppUrl(url) && (await acorn.isLoggedIn(acornSession()).catch(() => false))) done(true);
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-navigate-in-page', check);
    win.loadURL(acorn.HOME).catch(() => done(false));
  });
}

async function fetchData() {
  try {
    return await acorn.fetchAll(acornSession(), readCache(), log);
  } catch (err) {
    if (err.code !== 'LOGIN_REQUIRED') throw err;
    const ok = await silentLogin();
    sessionLog(ok ? 'refresh: acorn session expired, silent sso ok' : 'refresh: acorn session expired, silent sso failed');
    if (!ok) throw err;
    return acorn.fetchAll(acornSession(), readCache(), log);
  }
}

// 每 10 分钟发一个很轻的请求，免得 ACORN 和登录服务器的会话因为闲置过期；
// 已经过期就马上试静默续登，而不是等到下一次 3 小时一次的刷新
async function keepAlive() {
  if (refreshing || loginWin || status.state === 'login') return;
  try {
    if (await acorn.isLoggedIn(acornSession())) return;
    const ok = await silentLogin();
    sessionLog(ok ? 'keepalive: acorn session expired, silent sso ok' : 'keepalive: acorn session expired, silent sso failed');
    if (!ok) publish({ status: { state: 'login' } });
  } catch (err) {
    log('keepalive error:', err.message); // 断网、刚唤醒之类，下一轮再试
  }
}

function refresh() {
  refreshing ??= (async () => {
    publish({ status: { state: 'loading' } });
    try {
      const data = await fetchData();
      writeCache(data);
      publish({ data, status: { state: 'ok' } });
      sessionLog('refresh ok');
    } catch (err) {
      log('refresh failed:', err);
      if (err.code === 'LOGIN_REQUIRED') sessionLog('refresh: login required');
      publish({ status: err.code === 'LOGIN_REQUIRED' ? { state: 'login' } : { state: 'error', message: err.message } });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---- 登录：用户在真实的 UofT 登录页里输密码和 MFA，我们只拿回会话 cookie ----

function login() {
  if (loginWin) {
    loginWin.show();
    loginWin.focus();
    return loginPromise;
  }
  loginWin = new BrowserWindow({
    width: 520,
    height: 760,
    title: '登录 ACORN',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION },
  });
  loginPromise = new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    const onNavigate = async (_event, url) => {
      if (done || !acorn.isAcornAppUrl(url)) return;
      if (!(await acorn.isLoggedIn(acornSession()))) return;
      sessionLog('login');
      finish(true);
      // 调试模式下保留登录窗口，方便通过 remote debugging 查看 ACORN 的接口
      if (!DEBUG) loginWin?.close();
    };
    loginWin.webContents.on('did-navigate', onNavigate);
    loginWin.webContents.on('did-navigate-in-page', onNavigate);
    loginWin.on('closed', () => {
      loginWin = null;
      loginPromise = null;
      finish(false);
    });
  });
  loginWin.loadURL(acorn.HOME);
  app.focus({ steal: true });
  return loginPromise;
}

async function loginAndRefresh() {
  if (await login()) await refresh();
}

async function signOut() {
  await acornSession().clearStorageData();
  fs.rmSync(file('cache.bin'), { force: true });
  publish({ data: null, status: { state: 'login' } });
}

// ---- 小组件窗口 ----

function onSomeDisplay(b) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
}

function createWidget() {
  const { workArea } = screen.getPrimaryDisplay();
  const defaults = { width: 360, height: 560, x: workArea.x + workArea.width - 384, y: workArea.y + 24 };
  const bounds = state.bounds && onSomeDisplay(state.bounds) ? state.bounds : defaults;

  widget = new BrowserWindow({
    ...bounds,
    minWidth: 300,
    minHeight: 380,
    frame: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: state.pinned,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });

  let saveTimer;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.bounds = widget.getBounds();
      saveState();
    }, 400);
  };
  widget.on('moved', rememberBounds);
  widget.on('resized', rememberBounds);
  widget.on('closed', () => (widget = null));
  widget.once('ready-to-show', () => widget.show());

  widget.webContents.on('will-navigate', (event) => event.preventDefault());
  widget.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  widget.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function showWidget() {
  if (!widget) return createWidget(); // ready-to-show 时会自己显示
  widget.show();
  widget.focus();
}

// 被别的窗口挡住时点一下是"拿到前面"，已经在最前面时再点才是隐藏
function toggleWidget() {
  if (widget?.isVisible() && widget.isFocused()) widget.hide();
  else showWidget();
}

function setPinned(pinned) {
  state.pinned = pinned;
  saveState();
  widget?.setAlwaysOnTop(pinned, 'floating');
  widget?.webContents.send('widget:pinned', pinned);
}

// ---- 开机自启（只对打包后的 .app 生效；npm start 跑的是 Electron 本体，不能登记成登录项） ----

function setAutoLaunch(on) {
  app.setLoginItemSettings({ openAtLogin: on });
  log('login item', app.getLoginItemSettings());
}

// ---- 菜单栏图标 ----

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: widget?.isVisible() ? '隐藏小组件' : '显示小组件', click: toggleWidget },
    { label: '置顶', type: 'checkbox', checked: state.pinned, click: (item) => setPinned(item.checked) },
    ...(app.isPackaged
      ? [{ label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => setAutoLaunch(item.checked) }]
      : []),
    { type: 'separator' },
    { label: '刷新', click: () => refresh() },
    { label: '登录 ACORN…', click: loginAndRefresh },
    { label: '退出登录并清除本地数据', click: signOut },
    { type: 'separator' },
    { label: '退出', role: 'quit' },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
  tray = new Tray(icon);
  if (icon.isEmpty()) tray.setTitle('ACORN'); // 图标读不到时至少显示文字，不至于在菜单栏里"隐身"
  log('tray icon size', icon.getSize());
  tray.setToolTip('ACORN');
  tray.on('click', toggleWidget);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
}

// ---- 启动 ----

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => showWidget());
app.on('window-all-closed', () => {}); // 关掉小组件也不退出，点 Dock 图标就能再打开

app.whenReady().then(() => {
  loadState();
  persistAuthCookies();
  sessionLog('started');

  // 点 Dock 图标、在应用程序文件夹里再次双击时：把小组件显示出来并放到最前面
  app.on('activate', showWidget);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));

  // 打包版第一次启动时默认打开开机自启，之后以菜单里的选择为准
  if (app.isPackaged && !state.autoLaunchSet) {
    setAutoLaunch(true);
    state.autoLaunchSet = true;
    saveState();
  }

  ipcMain.handle('acorn:get-state', () => ({ data: readCache(), status, pinned: state.pinned }));
  ipcMain.handle('acorn:refresh', () => refresh());
  ipcMain.handle('acorn:login', () => loginAndRefresh());
  ipcMain.handle('widget:toggle-pin', () => setPinned(!state.pinned));
  ipcMain.on('widget:hide', () => widget?.hide());
  ipcMain.on('widget:menu', () => trayMenu().popup({ window: widget }));

  createTray();
  createWidget();

  refresh().then(() => {
    // 第一次用、本地什么都没有时，直接弹登录
    if (status.state === 'login' && !readCache()) loginAndRefresh();
  });
  setInterval(refresh, REFRESH_EVERY_MS);
  setInterval(keepAlive, KEEPALIVE_EVERY_MS);
  powerMonitor.on('resume', () => setTimeout(keepAlive, 5000)); // 合盖唤醒后网络要几秒才通
});
