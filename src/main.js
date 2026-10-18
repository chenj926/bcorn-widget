const { app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, safeStorage, screen, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const acorn = require('./acorn');
const CourseTools = require('./shared/course-tools');
const UserBackup = require('./shared/user-backup');
const { createGradeStore } = require('./grade-store');

const DEBUG = !!process.env.ACORN_DEBUG;
const PARTITION = 'persist:acorn';

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

// ---- 数据刷新 ----

function publish(payload) {
  if (payload.status) status = payload.status;
  widget?.webContents.send('acorn:update', payload);
}

// Fetch only after an explicit Refresh or completed user-initiated login.
// Do not silently extend cookies, sign in, poll, or keep sessions alive.
async function fetchData() {
  return acorn.fetchAll(acornSession(), readCache(), log);
}

function refresh() {
  refreshing ??= (async () => {
    try {
      if (readCache()?.source === 'local') {
        const answer = await dialog.showMessageBox(widget, {
          type: 'warning', title: '刷新会替换本地修改',
          message: 'ACORN 刷新会替换导入或手动编辑的本地课程。',
          detail: '如需保留课程地址、候补信息或其他本地修改，请先取消并导出完整 JSON 备份。',
          buttons: ['取消', '刷新并替换'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (answer.response !== 1) return { canceled: true };
      }
      publish({ status: { state: 'loading' } });
      const data = await fetchData();
      data.source = 'acorn';
      writeCache(data);
      publish({ data, status: { state: 'ok' } });

    } catch (err) {
      log('refresh failed:', err);

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
    minWidth: 260,
    minHeight: 280,
    resizable: true,
    frame: false,
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' } : {}),
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    skipTaskbar: process.platform === 'darwin',
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
  status = readCache() ? { state: 'ok' } : { state: 'offline' };


  // 点 Dock 图标、在应用程序文件夹里再次双击时：把小组件显示出来并放到最前面
  app.on('activate', showWidget);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));

  ipcMain.handle('acorn:get-state', () => ({ data: readCache(), status, pinned: state.pinned, capabilities: { authentication: true, localSave: true, calendarExport: true } }));
  ipcMain.handle('acorn:refresh', () => refresh());
  const gradeStore = createGradeStore(app.getPath('userData'));
  ipcMain.handle('grades:load', () => gradeStore.load());
  ipcMain.handle('grades:save', (_event, book) => gradeStore.save(book));
  ipcMain.handle('data:clear', () => {
    fs.rmSync(file('cache.bin'), { force: true });
    const payload = { data: null, status: { state: 'offline' }, pinned: state.pinned };
    publish(payload);
    return payload;
  });
  ipcMain.handle('data:save', (_event, input) => {
    const result = CourseTools.validateImport(input);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    writeCache(result.data);
    publish({ data: result.data, status: { state: 'ok' } });
    return { ok: true, warnings: result.warnings };
  });
  ipcMain.handle('data:import', async () => {
    const result = await dialog.showOpenDialog(widget, { properties: ['openFile'], filters: [{ name: 'Timetable JSON', extensions: ['json'] }] });
    if (result.canceled) return { canceled: true };
    const stat = fs.statSync(result.filePaths[0]);
    if (stat.size > 5 * 1024 * 1024) throw new Error('Import is limited to 5 MiB');
    const parsed = CourseTools.validateImport(fs.readFileSync(result.filePaths[0], 'utf8'));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    writeCache(parsed.data);
    publish({ data: parsed.data, status: { state: 'ok' } });
    return { ok: true, data: parsed.data, warnings: parsed.warnings };
  });
  ipcMain.handle('calendar:export', async (_event, { filename, content }) => {
    if (typeof content !== 'string' || content.length > 10 * 1024 * 1024) throw new Error('Invalid export');
    const isJson = typeof filename === 'string' && filename.toLowerCase().endsWith('.json');
    if (isJson) {
      const validation = UserBackup.parse(content);
      content = JSON.stringify(validation.kind === 'backup' ? UserBackup.create(validation.timetable, validation.gradebook, validation.preferences) : validation.timetable, null, 2);
    } else if (!content.startsWith('BEGIN:VCALENDAR')) throw new Error('Invalid calendar');
    const result = await dialog.showSaveDialog(widget, { defaultPath: path.basename(filename || 'timetable.ics'), filters: [{ name: isJson ? 'Timetable JSON' : 'iCalendar', extensions: [isJson ? 'json' : 'ics'] }] });
    if (result.canceled) return { canceled: true };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { ok: true };
  });
  ipcMain.handle('external:open', async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['www.google.com', 'uri.amap.com'].includes(parsed.hostname)) throw new Error('Only Google Maps and AMap links are supported');
    await shell.openExternal(parsed.href);
    return { ok: true };
  });
  ipcMain.handle('acorn:login', () => loginAndRefresh());
  ipcMain.handle('widget:toggle-pin', () => setPinned(!state.pinned));
  ipcMain.on('widget:hide', () => widget?.hide());
  ipcMain.on('widget:menu', () => trayMenu().popup({ window: widget }));

  createTray();
  createWidget();

  // Startup is offline: cached data only. Network access is user initiated.
});
