# DeepSeek Harness 桌面端（dsh-desktop）

DeepSeek Harness 的 Windows 桌面客户端：用 Electron 原生窗口内嵌 DSH Web GUI
（默认 `http://127.0.0.1:3080`），并通过 **GitHub Releases + electron-updater** 实现自动更新。

## 功能

- 🖥️ 原生桌面窗口直接加载 DeepSeek Harness Web 界面，功能与网页版完全一致
- 🔁 服务端未启动时显示友好的降级页：提供启动指引、服务器地址配置、一键重连
- ⚙️ **服务端托管**：连接失败时自动在后台拉起 `dsh web --no-open` 并等待就绪后自动重连，
  退出应用时自动关闭（可在降级页中开关托管、修改启动命令，也可手动启停）
- 🪟 **系统托盘**：关闭窗口最小化到托盘（不退出），托盘菜单可显示窗口、检查更新、开关开机自启、退出
- 🚀 **开机自启**：可在托盘菜单或设置中开启，随 Windows 登录自动启动
- ⚙️ 服务器地址可在降级页中修改并持久化（支持本地或远程 DSH 服务）
- 🔄 自动更新：启动 5 秒后检查一次，此后每 4 小时检查一次；新版本后台下载，
  下载完成弹窗提示「立即重启安装」；页面右上角有更新进度横幅
- 📦 单实例运行；外部链接自动交给系统浏览器

## 环境要求

- Windows 10/11 x64
- Node.js ≥ 20（仅开发/打包需要，运行安装包不需要）

## 开发运行

```bash
npm install     # 安装依赖（首次会下载 Electron 二进制）
npm run icon    # 生成 build/icon.png 与 build/icon.ico
npm start       # 以开发模式启动（此时自动更新禁用）
```

开发模式下菜单「帮助 → 检查更新」会提示“开发模式不检查更新”。

## 打包

```bash
npm run pack    # 仅生成未打包目录 dist/win-unpacked（快速验证）
npm run dist    # 生成 NSIS 安装包（默认在 dist/ 下）
```

产物包括：

- `dist/DeepSeek-Harness-Setup-<版本>.exe` —— NSIS 安装包
- `dist/latest.yml` —— 自动更新清单（发布到 GitHub Releases 后由客户端读取）

> 未配置代码签名证书时安装包未签名，Windows SmartScreen 会提示“未知发布者”，
> 属正常现象，选择“仍要运行”即可；后续可配置证书消除提示。

## 自动更新机制

1. 开发者发布新版本：打 tag（如 `v0.2.0`）推送到 GitHub，触发
   [.github/workflows/release.yml](.github/workflows/release.yml) 自动构建，
   并把 `DeepSeek-Harness-Setup-*.exe` + `latest.yml` 上传到对应 tag 的 Release。
2. 客户端启动后 electron-updater 读取 Release 中的 `latest.yml`，
   比对版本号（要求使用语义化版本，新版本号必须大于当前版本）。
3. 发现新版本自动后台下载，完成后弹窗询问是否立即重启安装。

### 仓库配置（已完成）

仓库已配置为 **github.com/yi1k/DpsK**（`package.json` 的 `repository` 与 `build.publish` 均已指向该仓库）。

**私有仓库说明**：electron-updater 默认无法读取私有仓库的 Release。两种解决方式：

- **方式 1（推荐）**：在 GitHub 仓库 Settings 里把仓库改为 **Public**，无需其他配置；
- **方式 2（保持私有）**：在 `%APPDATA%/DeepSeek Harness/settings.json` 中加 `"updateToken": "<你的 GitHub PAT>"`（PAT 需 `repo` 权限），应用会用令牌读取 Release。

如需迁移到别的仓库，改 `package.json` 两处：

```jsonc
"repository": { "url": "https://github.com/<你的用户名>/dsh-desktop.git" },
"build": {
  "publish": { "provider": "github", "owner": "<你的用户名>", "repo": "dsh-desktop" }
}
```

### 发布一个新版本

```bash
npm version patch   # 或 minor / major，自动更新版本号并打 tag
git push origin main --tags   # GitHub Actions 会自动构建并发布 Release
```

之后所有已安装的客户端会在下一次检查时收到更新。

### 手动触发检查

菜单「帮助 → 检查更新」，或任意页面右上角更新横幅。

## 配置说明

| 配置 | 位置 | 说明 |
| --- | --- | --- |
| 服务器地址 | 降级页输入框（保存于 `%APPDATA%/DeepSeek Harness/settings.json`） | 默认 `http://127.0.0.1:3080`，支持 http/https |
| 服务端托管 | 降级页「服务端托管」开关 | 默认开启：连接失败时自动拉起服务端，退出时关闭 |
| 服务端启动命令 | 降级页「启动命令」输入框 | 默认 `dsh web --no-open`（`--no-open` 避免拉起服务时打开浏览器）；`npx dsh web` 不可用，因为 npx 解析不了裸命令 `dsh` |
| 开机自启 | 托盘菜单「开机自启」 | 默认关闭；仅打包安装版生效 |
| 更新检查间隔 | `src/main.js` 中 `UPDATE_CHECK_INTERVAL_MS` | 默认 4 小时 |
| 运行日志 | `%APPDATA%/DeepSeek Harness/main.log` | 主进程关键事件与更新检查日志（更新失败排查用） |

## 目录结构

```
dsh-desktop/
├── src/
│   ├── main.js            # Electron 主进程：窗口、设置、自动更新、IPC
│   ├── preload.js         # contextBridge 安全 API + 更新横幅注入
│   └── fallback.html      # 服务端未启动时的降级页
├── scripts/
│   └── generate-icon.mjs  # 纯 Node 生成 build/icon.png 与 icon.ico
├── build/                 # 图标等构建资源（icon 由脚本生成）
├── .github/workflows/
│   └── release.yml        # 打 tag 自动构建并发布到 GitHub Releases
└── package.json           # electron-builder 配置
```

## 常见问题

**Q：打开后一直显示“无法连接到 DSH 服务端”？**
如果启用了服务端托管，桌面端会自动尝试启动 `dsh web --no-open`，稍等片刻即会自动重连；
若启动失败或托管已关闭，请手动在命令行运行 `dsh web`（`dsh` 不在 PATH 时用 `npx @deepseek-ai/dsh web`），再点击「重试连接」。
服务跑在其他地址/端口时，在降级页修改服务器地址后保存。

**Q：服务端托管没生效？**
- 确认降级页「服务端托管」开关已打开（默认开启）；
- 确认「启动命令」正确（默认 `dsh web --no-open`；`dsh` 会自动从 npx 缓存解析，不依赖 PATH）；
- 查看 `%APPDATA%/DeepSeek Harness/main.log` 中 `server:` 开头的日志定位原因；
- 服务端就绪超时默认为 60 秒，启动较慢时点击「重试连接」可手动重连。

**Q：点窗口关闭按钮后应用还在托盘里？**
这是设计行为：关闭窗口会最小化到系统托盘，应用继续在后台运行（保持服务端连接）。
需要真正退出时，使用托盘菜单或应用菜单「文件 → 退出」。

**Q：更新没有生效？**
- 确认安装的是打包版（开发模式不检查更新）；
- 确认 GitHub Release 的 tag 版本号高于当前安装版本；
- 确认 Release 中同时包含 `latest.yml` 与安装包（工作流会自动上传）。

**Q：能不能自动启动 DSH 服务端？**
当前版本不做服务端托管（服务由 `dsh web` 单独启动）。后续可增加“随应用启动/停止服务端”的选项。

## 路线图（待确认需求）

- [x] 服务端随应用自启/自停
- [x] 系统托盘 + 开机自启
- [ ] 原生聊天界面（对接 DSH API）
- [ ] macOS / Linux 支持
- [ ] 自建更新服务器（内网分发）
