# EdgeTerm

[English](README.md) | [简体中文](README.zh-CN.md)

一个仿照 [WindTerm](https://github.com/kingToolbox/WindTerm) 的终端 / SSH / FTP / 串口客户端，用 **Rust + Tauri v2** 构建，前端为 React + xterm.js。

整个 SSH 栈是纯 Rust 的（russh），不依赖 libssh2、OpenSSL 或 pkg-config，因此在任何装了 Rust 工具链的机器上都能直接编译。

## 功能

**会话类型**

| 类型 | 后端实现 | 说明 |
| --- | --- | --- |
| 本地 Shell | `portable-pty` | 真正的伪终端，支持窗口尺寸同步 |
| SSH | `russh` + `russh-sftp` | 密码 / 公钥 / ssh-agent 认证，SFTP 复用同一条连接，文件及文件夹流式传输 |
| FTP | `suppaftp` | 密码或匿名认证，被动模式浏览，自动识别 UTF-8 / GBK 文件名，文件及文件夹双向流式传输 |
| 串口 | `serialport` | 波特率、数据位、停止位、校验、流控可配 |

SSH / FTP 密码和 SSH 私钥口令保存在应用配置目录下仅当前系统用户可读的 `credentials.json` 中，不会返回给前端，也不会写入 `sessions.json`。因此重启 EdgeTerm 后可直接连接已保存的会话，不会触发 macOS Keychain 的电脑密码授权框。

标准 FTP 不加密凭据和文件内容，只应在可信网络中使用；需要传输安全时请使用 SSH / SFTP。

**界面**（对应 WindTerm 的布局）

- **时间戳 + 行号侧栏** —— WindTerm 最有辨识度的特性，每一行输出都带 `[HH:MM:SS.SSS]` 与累计行号，光标行高亮。可在 `Session` 菜单下切换四种显示模式。
- **丰富色彩渲染** —— 支持 ANSI 16 色、256 色和 24-bit 真彩，并为无 ANSI 样式的输出补充比 WindTerm 更丰富的暖色语义着色：提示符、选项、运算符与彩虹括号、`ls -l` 权限位与属主列、表头行、日志级别与 Kubernetes/Docker/systemd 状态、网络地址与域名、路径、Git diff、HTTP、JSON/YAML 等，并为错误/警告、diff 和表头行加淡色底带，为链接加下划线。
- **Filer**（左侧）：文件浏览器。SSH 会话下自动切到 SFTP，可上传 / 下载文件和文件夹（支持拖拽上传）、新建目录、删除；其他终端会话下浏览本地文件系统
- **FTP 工作区**：FTP 会话使用独立的双栏文件管理器，左侧为 FTP 服务器，右侧为本机，支持文件和整个文件夹的双向流式传输，以及新建、重命名和非递归删除
- **Session**（右侧）：保存的连接配置，按分组折叠，双击连接
- **Sender**（底部）：批量发送。支持文本 / 十六进制、按行 / 按字符、重复次数、发送间隔、目标为当前会话或全部会话
- 标签页、地址栏（`ssh › host:port`）、状态栏（窗口尺寸、光标 Ln/Ch、协议）

**ZMODEM 传输**

本地 Shell、SSH 和串口终端会自动检测 ZMODEM 会话。在终端中执行 `rz` 后可选择一个或多个本地文件并发送；执行 `sz <文件>` 后可为每个接收文件选择保存位置。对端需要安装兼容的 `rz` / `sz` 实现（例如 `lrzsz`）。文件 I/O 和终端输出始终按原始二进制处理，并使用固定 1 MiB 应用层分块读写文件。传输过程中可通过 **Session → Cancel ZMODEM Transfer** 主动取消。

**快捷键**

| macOS | Windows / Linux | 动作 |
| --- | --- | --- |
| `⌘N` | `Alt+N` | 新建会话对话框 |
| `⌘W` | `Ctrl+Shift+W` | 关闭当前会话（会话仍在线时会弹出确认，`Enter` 关闭，`Esc` 取消） |
| `⌘F` / `⌘G` | `Ctrl+Shift+F` / `Ctrl+Shift+G` | 缓冲区内查找 / 下一个匹配 |
| `⌘K` | `Alt+K` | 清屏 |
| `⌘[` / `⌘]` | `Alt+[` / `Alt+]` | 切换到上一个 / 下一个已打开会话 |
| `⌘1`–`⌘9` | `Alt+1`–`Alt+9` | 切换到第 N 个标签 |
| `⌘⌥←` / `⌘⌥→` / `⌘⌥↓` | `Ctrl+Alt+←` / `Ctrl+Alt+→` / `Ctrl+Alt+↓` | 显示或隐藏 Filer / Session / Sender |
| `⌘C` / `⌘V` | `Ctrl+Shift+C` / `Ctrl+Shift+V` | 复制 / 粘贴（终端内） |
| `⌘A` | `Ctrl+Shift+A` | 全选终端缓冲区 |

## 自动更新

正式构建启动后会自动检查 GitHub 上的 Latest Release；发现更高版本时可在应用内下载、校验签名、安装并重启。也可以随时使用 **Help → Check for Updates…** 手动检查。更新源固定为仓库 Release 中由发布工作流生成的 `latest.json`，支持 Windows x64、macOS Apple Silicon，以及 Linux x64 / ARM64；Linux AppImage 和 DEB 安装会按原包格式更新。

更新包使用 Tauri updater 密钥签名，签名校验不能关闭。公钥已经固定在 `src-tauri/tauri.conf.json`，对应私钥仅保存在发布环境中。首次使用新工作流前，仓库管理员必须把本机生成的私钥配置为 Actions Secret：

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY \
  --repo miskin-lee/EdgeTerm \
  < ~/.tauri/edgeterm-updater.key

security find-generic-password \
  -a EdgeTerm \
  -s com.edgeterm.updater-signing \
  -w | tr -d '\n' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    --repo miskin-lee/EdgeTerm
```

私钥密码保存在 macOS 登录钥匙串的 `com.edgeterm.updater-signing` 条目。务必把 `~/.tauri/edgeterm-updater.key` 和对应密码分别安全备份；丢失或替换其中任何一个后，已经安装的版本将无法验证后续更新。私钥和密码不得提交到 Git、Release 或构建 Artifact。

## 运行

```bash
npm install
npm run tauri dev      # 开发模式
npm run tauri build -- --no-bundle  # 仅编译验证，不生成安装包

# 维护者本地生成带 updater 签名的安装包
TAURI_SIGNING_PRIVATE_KEY="$(< "$HOME/.tauri/edgeterm-updater.key")" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password \
  -a EdgeTerm -s com.edgeterm.updater-signing -w)" \
  npm run tauri build
```

要求：Rust 1.80.1+、Node 20.19+（推荐 Node 22 LTS）。macOS 需要 Xcode Command Line Tools。

## 发布

Release 由 GitHub Actions 上的 [Release 工作流](.github/workflows/release.yml)构建并发布。每个 Release 包含：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | NSIS 安装程序（`.exe`） |
| macOS Apple Silicon | `.dmg`，以及应用内更新使用的 `.app.tar.gz` |
| Linux x64 / ARM64 | `.AppImage` 和 `.deb` |

Release 不做 macOS 公证和 Windows Authenticode 代码签名，macOS 应用只使用 ad-hoc 签名。这与 updater 包签名是两套机制，首次安装时系统仍可能弹出安全提示。

## 已知限制

- ZMODEM 暂不支持断点续传；中断后需要从头重新传输。
- 尚未实现：端口转发 / 隧道、会话录制回放、多标签分屏。
