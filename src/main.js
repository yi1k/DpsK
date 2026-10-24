'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3080';
// 注意：不要用 `npx dsh web` —— npx 无法解析裸命令 `dsh`（报 could not determine executable to run）。
// `dsh` 本身就在 PATH 上（npx 缓存 .bin 目录）；--no-open 防止拉起服务时额外打开浏览器。
const DEFAULT_SERVER_COMMAND = 'dsh web --no-open';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 每 4 小时检查一次更新
const SERVER_READY_TIMEOUT_MS = 60 * 1000; // 托管服务端等待就绪超时

let mainWindow = null;
let fallbackShown = false;
let updateStatus = { state: 'idle' };
let tray = null;
let isQuitting = false;
let managedServer = null; // 本应用拉起的 DSH 服务端子进程
let serverStarting = false;
let serverSpawnedThisSession = false;
let serverStatus = { state: 'idle' };

// ---------------------------------------------------------------------------
// 日志与异常兜底（日志写入 userData/main.log）
// ---------------------------------------------------------------------------
function logMain(...args) {
  try {
    const file = path.join(app.getPath('userData'), 'main.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
  } catch {
    // 日志写入失败时静默忽略
  }
}

process.on('uncaughtException', (err) => {
  logMain('UNCAUGHT_EXCEPTION:', (err && err.stack) || err);
});

process.on('unhandledRejection', (reason) => {
  logMain('UNHANDLED_REJECTION:', (reason && (reason.stack || reason)) || reason);
});

// ---------------------------------------------------------------------------
// 设置持久化（存放于 userData/settings.json）
// ---------------------------------------------------------------------------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    // 去掉可能的 UTF-8 BOM（部分编辑器/脚本保存时可能写入）
    const raw = fs.readFileSync(settingsPath(), 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function getServerUrl() {
  const s = readSettings();
  return typeof s.serverUrl === 'string' && s.serverUrl.trim()
    ? s.serverUrl.trim()
    : DEFAULT_SERVER_URL;
}

function getServerCommand() {
  const s = readSettings();
  return typeof s.serverCommand === 'string' && s.serverCommand.trim()
    ? s.serverCommand.trim()
    : DEFAULT_SERVER_COMMAND;
}

function isManageServerEnabled() {
  const s = readSettings();
  return s.manageServer !== false; // 默认开启
}

function isAutoLaunchEnabled() {
  const s = readSettings();
  return !!s.autoLaunch;
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function broadcastUpdate(status) {
  updateStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', status);
  }
}

function broadcastServer(status) {
  serverStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-status', status);
  }
}

function loadServer() {
  if (!mainWindow) return;
  fallbackShown = false;
  logMain('load: attempt', getServerUrl());
  mainWindow
    .loadURL(getServerUrl())
    .catch(() => loadFallback());
}

function loadFallback() {
  if (!mainWindow || fallbackShown) return;
  fallbackShown = true;
  logMain('load: fallback page shown');
  mainWindow
    .loadFile(path.join(__dirname, 'fallback.html'), { query: { serverUrl: getServerUrl() } })
    .catch(() => {});
}

// 连接失败：若启用了托管且本会话未尝试过，则自动拉起服务端
function handleConnectionFailure() {
  if (isManageServerEnabled() && !managedServer && !serverStarting && !serverSpawnedThisSession) {
    serverSpawnedThisSession = true;
    startManagedServer();
  }
  loadFallback();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    // 去掉原生白色标题栏：隐藏标题栏但仍保留最小化/最大化/关闭按钮，
    // 按钮以叠加(overlay)形式浮在内容右上角。这样内容铺满整窗、顶部不再有白边。
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // 叠加按钮背景设为全透明：三个按钮直接浮在页面/壁纸上。
      // 注意：部分 Windows 版本可能把叠加区域仍渲染成有底色，届时可按需微调，
      // 或改用 frame:false + 自绘按钮（改动更大）。
      color: '#00000000',
      symbolColor: '#f1f5f9',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 主页面加载失败（如服务端未启动）→ 尝试托管拉起 / 显示降级页
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED（导航被中止，忽略）
    handleConnectionFailure();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    fallbackShown = false;
    // 页面切换（含重连成功）后把当前更新/服务端状态重新同步给页面
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', updateStatus);
      mainWindow.webContents.send('server-status', serverStatus);
    }
  });

  // 关闭窗口 → 最小化到托盘（真正退出走托盘/菜单“退出”）
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  loadServer();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('DeepSeek Harness');
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '重新加载', click: () => mainWindow && mainWindow.webContents.reload() },
      { label: '检查更新', click: () => checkForUpdates(true) },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: isAutoLaunchEnabled(),
        click: (item) => setAutoLaunch(item.checked),
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

// ---------------------------------------------------------------------------
// 开机自启
// ---------------------------------------------------------------------------
function setAutoLaunch(enabled) {
  writeSettings({ autoLaunch: !!enabled });
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
  }
  refreshTrayMenu();
  logMain('autolaunch: set', !!enabled);
}

function applyAutoLaunch() {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: isAutoLaunchEnabled() });
  }
}

// ---------------------------------------------------------------------------
// 服务端托管：连接失败时自动拉起 `dsh web`，退出时关闭
// ---------------------------------------------------------------------------
function probeServer(timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    try {
      const u = new URL(getServerUrl());
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const req = lib.get(u, { timeout: timeoutMs }, (res) => {
        res.resume();
        finish(true);
      });
      req.on('timeout', () => {
        req.destroy();
        finish(false);
      });
      req.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

// 从 npx 缓存中定位 dsh 的真实 Node 入口（lib/bin.js），找不到返回 null。
// 这样即使 PATH 里没有 dsh/npx 也能拉起服务端。
function resolveDshBinFromNpxCache() {
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;
    const npxRoot = path.join(localAppData, 'npm-cache', '_npx');
    if (!fs.existsSync(npxRoot)) return null;
    const dirs = fs
      .readdirSync(npxRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(npxRoot, d.name));
    for (const dir of dirs) {
      const candidate = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // 忽略：找不到就回退到 PATH 上的 dsh
  }
  return null;
}

// 归一化启动命令：
// - 去掉 `npx` 前缀（npx 解析不了裸命令 dsh，直接调 dsh 反而可用）
// - 其余原样保留
function normalizeServerCommand(command) {
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts[0] === 'npx') {
    const i = parts.indexOf('dsh');
    if (i > -1) parts.splice(0, i);
  }
  return parts.join(' ');
}

function startManagedServer() {
  if (managedServer || serverStarting) return;
  serverStarting = true;
  const command = normalizeServerCommand(getServerCommand());
  logMain('server: starting managed server:', command);
  broadcastServer({ state: 'starting', command });

  const parts = command.split(/\s+/).filter(Boolean);
  let bin = parts[0];
  let args = parts.slice(1);

  // 目标是 dsh 时，优先直接用 npx 缓存里的真实入口（node bin.js ...），
  // 不依赖 PATH/npx 解析，最稳。
  if (bin === 'dsh') {
    const binJs = resolveDshBinFromNpxCache();
    if (binJs) {
      logMain('server: using npx-cache dsh entry:', binJs);
      bin = 'node';
      args = [binJs, ...args];
    }
  }

  const child = spawn(bin, args, { shell: true, windowsHide: true, stdio: 'ignore' });
  managedServer = child;

  child.on('error', (err) => {
    logMain('server: spawn error:', err.message);
    serverStarting = false;
    managedServer = null;
    broadcastServer({ state: 'failed', message: '无法启动服务端进程：' + (err.message || err) });
  });

  child.on('exit', (code, signal) => {
    logMain('server: exited code=' + code + ' signal=' + signal);
    if (serverStarting) {
      serverStarting = false;
      broadcastServer({ state: 'failed', message: '服务端进程已退出（code ' + code + '）' });
    }
    managedServer = null;
  });

  // 轮询等待服务端就绪（默认 60 秒超时）
  let attempts = 0;
  const poll = async () => {
    if (!managedServer) return;
    attempts += 1;
    const ok = await probeServer();
    if (ok) {
      serverStarting = false;
      logMain('server: ready after', attempts, 'attempts');
      broadcastServer({ state: 'started' });
      loadServer();
      return;
    }
    if (attempts * 1000 >= SERVER_READY_TIMEOUT_MS) {
      serverStarting = false;
      broadcastServer({ state: 'failed', message: '等待服务端就绪超时（' + Math.round(SERVER_READY_TIMEOUT_MS / 1000) + ' 秒）' });
      return;
    }
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 500);
}

function stopManagedServer() {
  if (!managedServer) return;
  const pid = managedServer.pid;
  logMain('server: stopping managed server pid=' + pid);
  broadcastServer({ state: 'stopping' });
  try {
    // taskkill 连子进程树一起结束（npx 会派生子进程）
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } catch (err) {
    logMain('server: taskkill error:', (err && err.message) || err);
  }
  managedServer = null;
  serverStarting = false;
  broadcastServer({ state: 'stopped' });
}

// ---------------------------------------------------------------------------
// 自动更新（electron-updater + GitHub Releases）
// ---------------------------------------------------------------------------
function initAutoUpdater() {
  // 自定义 logger 写入 userData/main.log：
  // 打包后的 GUI 应用无控制台，electron-updater 默认写 console 会触发 EPIPE 未捕获异常
  autoUpdater.logger = {
    info: (m) => logMain('updater:', m),
    warn: (m) => logMain('updater warn:', m),
    error: (m) => logMain('updater error:', m),
    debug: (m) => logMain('updater debug:', m),
  };

  autoUpdater.autoDownload = true; // 发现新版本后自动后台下载
  autoUpdater.autoInstallOnAppQuit = true; // 退出应用时自动安装

  autoUpdater.on('checking-for-update', () =>
    broadcastUpdate({ state: 'checking', manual: !!updateStatus.manual })
  );

  autoUpdater.on('update-available', (info) => {
    logMain('update: available', info && info.version);
    broadcastUpdate({ state: 'available', version: info.version, manual: !!updateStatus.manual });
  });

  autoUpdater.on('update-not-available', () => {
    logMain('update: not available');
    broadcastUpdate({ state: 'up-to-date', version: app.getVersion(), manual: !!updateStatus.manual });
  });

  autoUpdater.on('download-progress', (p) =>
    broadcastUpdate({
      state: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
      manual: !!updateStatus.manual,
    })
  );

  autoUpdater.on('update-downloaded', (info) => {
    broadcastUpdate({ state: 'downloaded', version: info.version });
    const opts = {
      type: 'info',
      title: '更新已就绪',
      message: `DeepSeek Harness ${info.version} 已下载完成。`,
      detail: '是否立即重启并安装新版本？',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const p = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    p.then(({ response }) => {
      if (response === 0) installUpdate();
    }).catch(() => {});
  });

  autoUpdater.on('error', (err) => {
    logMain('update: error:', (err && err.message) || err);
    broadcastUpdate({
      state: 'error',
      message: String((err && err.message) || err),
      manual: !!updateStatus.manual,
    });
  });
}

function checkForUpdates(manual = false) {
  updateStatus.manual = manual;
  if (!app.isPackaged) {
    broadcastUpdate({ state: 'dev', manual, message: '开发模式不检查更新（打包安装后自动启用）' });
    return;
  }
  logMain('update: check start (manual=' + manual + ')');
  broadcastUpdate({ state: 'checking', manual });
  try {
    autoUpdater
      .checkForUpdates()
      .catch((err) => {
        logMain('update: check failed:', (err && err.message) || err);
        broadcastUpdate({ state: 'error', message: String((err && err.message) || err), manual });
      });
  } catch (err) {
    logMain('update: check threw synchronously:', (err && err.stack) || err);
    broadcastUpdate({ state: 'error', message: String((err && err.message) || err), manual });
  }
}

function installUpdate() {
  if (updateStatus.state !== 'downloaded') return;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    serverUrl: getServerUrl(),
    defaultServerUrl: DEFAULT_SERVER_URL,
    updateStatus,
    serverStatus,
  }));

  ipcMain.handle('settings:get', () => ({
    serverUrl: getServerUrl(),
    defaultServerUrl: DEFAULT_SERVER_URL,
    serverCommand: getServerCommand(),
    defaultServerCommand: DEFAULT_SERVER_COMMAND,
    manageServer: isManageServerEnabled(),
    autoLaunch: isAutoLaunchEnabled(),
  }));

  ipcMain.handle('settings:set', (_e, patch) => {
    if (!patch || typeof patch !== 'object') {
      return { serverUrl: getServerUrl() };
    }
    if (typeof patch.serverUrl === 'string' && patch.serverUrl.trim()) {
      const serverUrl = patch.serverUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(serverUrl)) {
        throw new Error('服务器地址必须以 http:// 或 https:// 开头');
      }
      writeSettings({ serverUrl });
    }
    if (typeof patch.serverCommand === 'string') {
      if (!patch.serverCommand.trim()) {
        throw new Error('服务端启动命令不能为空');
      }
      writeSettings({ serverCommand: patch.serverCommand.trim() });
    }
    if (typeof patch.manageServer === 'boolean') {
      writeSettings({ manageServer: patch.manageServer });
    }
    if (typeof patch.autoLaunch === 'boolean') {
      setAutoLaunch(patch.autoLaunch);
    }
    return {
      serverUrl: getServerUrl(),
      serverCommand: getServerCommand(),
      manageServer: isManageServerEnabled(),
      autoLaunch: isAutoLaunchEnabled(),
    };
  });

  ipcMain.on('server:retry', () => loadServer());
  ipcMain.on('server:start', () => {
    // 手动启动：允许绕过“本会话已尝试”的自动保护
    serverSpawnedThisSession = false;
    startManagedServer();
  });
  ipcMain.on('server:stop', () => stopManagedServer());
  ipcMain.on('update:check', () => checkForUpdates(true));
  ipcMain.on('update:install', () => installUpdate());
}

// ---------------------------------------------------------------------------
// 菜单
// ---------------------------------------------------------------------------
function setupMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '服务',
      submenu: [
        { label: '启动 DSH 服务端', click: () => { serverSpawnedThisSession = false; startManagedServer(); } },
        { label: '停止 DSH 服务端', click: () => stopManagedServer() },
        { type: 'separator' },
        { label: '重新连接', click: () => loadServer() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新', click: () => checkForUpdates(true) },
        { type: 'separator' },
        {
          label: '关于',
          click: () =>
            dialog
              .showMessageBox(mainWindow, {
                type: 'info',
                title: '关于',
                message: 'DeepSeek Harness 桌面端',
                detail:
                  `版本 ${app.getVersion()}\n\n` +
                  '内嵌 DSH Web GUI 的 Electron 客户端，支持自动更新、系统托盘与 DSH 服务端托管。',
                buttons: ['确定'],
              })
              .catch(() => {}),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.on('before-quit', () => {
    isQuitting = true;
    stopManagedServer();
  });

  app.whenReady().then(() => {
    initAutoUpdater();
    registerIpc();
    setupMenu();
    applyAutoLaunch();
    createTray();
    createWindow();

    if (app.isPackaged) {
      // 启动 5 秒后检查一次更新，之后每 4 小时检查一次
      setTimeout(() => checkForUpdates(false), 5000);
      setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
    } else {
      broadcastUpdate({ state: 'dev', message: '开发模式：自动更新已禁用，打包安装后启用' });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    // 有托盘时窗口关闭会被拦截为隐藏；若托盘创建失败则正常退出
    if (!tray) app.quit();
  });
}
