'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// 暴露给页面（含降级页）的安全 API
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('dshDesktop', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  retryConnect: () => ipcRenderer.send('server:retry'),
  startServer: () => ipcRenderer.send('server:start'),
  stopServer: () => ipcRenderer.send('server:stop'),
  checkForUpdates: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateStatus: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
  onServerStatus: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('server-status', listener);
    return () => ipcRenderer.removeListener('server-status', listener);
  },
});

// ---------------------------------------------------------------------------
// 更新横幅：注入到加载的远程页面（http/https）右上角
// ---------------------------------------------------------------------------
if (/^https?:/i.test(window.location.protocol)) {
  window.addEventListener('DOMContentLoaded', () => {
    const id = 'dsh-desktop-update-banner';
    if (document.getElementById(id)) return;

    const css = document.createElement('style');
    css.textContent = `
      #dsh-desktop-update-banner {
        position: fixed; top: 12px; right: 12px; z-index: 2147483647;
        display: none; box-sizing: border-box;
        max-width: 340px; padding: 10px 14px;
        background: rgba(15, 23, 42, 0.96); color: #e2e8f0;
        border: 1px solid rgba(99, 102, 241, 0.55); border-radius: 10px;
        font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(6px);
      }
      #dsh-desktop-update-banner .dsh-banner-text { margin: 0; }
      #dsh-desktop-update-banner .dsh-banner-bar {
        height: 4px; margin-top: 8px; border-radius: 2px;
        background: rgba(255, 255, 255, 0.15); overflow: hidden;
      }
      #dsh-desktop-update-banner .dsh-banner-bar > span {
        display: block; height: 100%; width: 0%;
        background: linear-gradient(90deg, #6366f1, #22d3ee);
        transition: width 0.3s ease;
      }
      #dsh-desktop-update-banner .dsh-banner-btn {
        margin-top: 8px; padding: 5px 14px; cursor: pointer;
        background: linear-gradient(90deg, #6366f1, #4f46e5); color: #fff;
        border: 0; border-radius: 6px; font-size: 12px;
      }
      #dsh-desktop-update-banner .dsh-banner-btn:hover { filter: brightness(1.1); }
    `;
    document.head.appendChild(css);

    const banner = document.createElement('div');
    banner.id = id;
    banner.innerHTML = `
      <p class="dsh-banner-text"></p>
      <div class="dsh-banner-bar" style="display:none"><span></span></div>
      <button class="dsh-banner-btn" style="display:none">立即重启安装</button>
    `;
    document.body.appendChild(banner);

    const textEl = banner.querySelector('.dsh-banner-text');
    const barEl = banner.querySelector('.dsh-banner-bar');
    const barInner = barEl.querySelector('span');
    const btn = banner.querySelector('.dsh-banner-btn');

    btn.addEventListener('click', () => ipcRenderer.send('update:install'));

    let hideTimer = null;
    ipcRenderer.on('update-status', (_e, s) => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      let text = '';
      let show = false;
      let withBar = false;
      let withBtn = false;

      switch (s.state) {
        case 'checking':
          text = '正在检查更新…'; show = true; break;
        case 'available':
          text = `发现新版本 v${s.version}，正在后台下载…`; show = true; withBar = true; break;
        case 'downloading':
          text = `正在下载更新 ${s.percent}%`; show = true; withBar = true;
          barInner.style.width = `${Math.max(0, Math.min(100, s.percent))}%`; break;
        case 'downloaded':
          text = `新版本 v${s.version} 已就绪`; show = true; withBtn = true; break;
        case 'up-to-date':
          if (s.manual) { text = '已是最新版本'; show = true; hideTimer = setTimeout(() => { banner.style.display = 'none'; }, 3000); }
          break;
        case 'error':
          if (s.manual) { text = '检查更新失败'; show = true; hideTimer = setTimeout(() => { banner.style.display = 'none'; }, 4000); }
          break;
        case 'dev':
          if (s.manual) { text = '开发模式：不检查更新'; show = true; hideTimer = setTimeout(() => { banner.style.display = 'none'; }, 4000); }
          break;
        default:
          show = false;
      }

      if (show) {
        textEl.textContent = text;
        barEl.style.display = withBar ? 'block' : 'none';
        if (!withBar) barInner.style.width = '0%';
        btn.style.display = withBtn ? 'inline-block' : 'none';
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 无边框拖动条：去掉顶部标题栏后，页面顶部不再有可拖动的原生区域，
// 因此在页面顶部注入一条透明拖动区域，让窗口仍可通过顶部拖动移动。
// 该区域 z-index(500) 低于更新横幅(z-index 2147483647)，不会遮挡横幅按钮；
// 原生最小化/最大化/关闭按钮位于窗口非客户端区域，天然不受页面元素影响。
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  const id = 'dsh-desktop-drag-strip';
  if (document.getElementById(id)) return;

  const css = document.createElement('style');
  css.textContent = `
    #dsh-desktop-drag-strip {
      position: fixed; top: 0; left: 0;
      width: 100%; height: 44px;
      z-index: 500;
      -webkit-app-region: drag;
      background: transparent;
      pointer-events: auto;
    }
  `;
  document.head.appendChild(css);

  const strip = document.createElement('div');
  strip.id = id;
  strip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(strip);
});
