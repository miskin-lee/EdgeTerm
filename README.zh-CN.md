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
| `⌘W` | `Alt+W` | 关闭当前会话（会话仍在线时会弹出确认，`Enter` 关闭，`Esc` 取消） |
| `⌘F` / `⌘G` | `Alt+F` / `Alt+G` | 缓冲区内查找 / 下一个匹配 |
| `⌘K` | `Ctrl+K` | 清屏 |
| `⌘←` / `⌘→` | `Ctrl+Shift+[` / `Ctrl+Shift+]` | 切换到上一个 / 下一个已打开会话 |
| `⌘1`–`⌘9` | `Ctrl+1`–`Ctrl+9` | 切换到第 N 个标签 |
| `⌘⌥←` / `⌘⌥→` / `⌘⌥↓` | `Ctrl+Alt+←` / `Ctrl+Alt+→` / `Ctrl+Alt+↓` | 显示或隐藏 Filer / Session / Sender |
| `⌘C` / `⌘V` | `Alt+C` / `Alt+V` | 复制 / 粘贴（终端内） |
| `⌘A` | `Alt+A` | 全选终端缓冲区 |

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

## 手动发布

需要发布时，在仓库的 **Actions → Release → Run workflow** 中手动触发。工作流会校验版本和 updater 私钥，创建草稿 Release，构建所有支持的平台并生成签名更新包。发布前会删除意外产物，并逐项核对安装包、更新包及其 `latest.json` 映射。

发布前使用以下命令设置版本并提交。它会同步 `package.json`、`package-lock.json`、`Cargo.toml` 和 `Cargo.lock`；Tauri 安装包也直接读取这个版本：

```bash
npm run version:set -- 0.1.1
```

Release tag 和软件版本严格一一对应，例如软件 `0.1.1` 只会发布为 `v0.1.1`。如果该 tag 已指向其他提交，工作流会停止并要求先提升版本，避免用同一版本号发布不同的软件内容。

当前生成以下原生安装包：

| 系统 | 架构 | Runner |
| --- | --- | --- |
| Linux | x64 | `ubuntu-22.04` |
| Linux | ARM64 | `ubuntu-22.04-arm` |
| Windows | x64 | `windows-2022` |
| macOS | Apple Silicon ARM64 | `macos-15` |

每个 Release 只包含 Linux x64 / ARM64 的 `.AppImage` 和 `.deb`、Windows x64 NSIS `.exe`、macOS Apple Silicon `.dmg` 及其 `.app.tar.gz` 更新包，以及 `latest.json`。不发布独立 `.sig`、`.rpm` 或 `.msi`；自动更新签名嵌入在 `latest.json` 中。Actions run 中仍会保留构建 Artifacts。工作流支持命令行触发：

```bash
gh workflow run release.yml
gh run watch
```

Release 默认不做 macOS 公证或 Windows Authenticode 代码签名；macOS 应用只使用 ad-hoc 签名。它们与 updater 包签名是两套不同机制，用户首次安装时仍可能看到系统安全提示；对外分发前应配置平台开发者证书。工作流文件见 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

## 已知限制

- ZMODEM 暂不支持断点续传；中断后需要从头重新传输。
- 尚未实现：端口转发 / 隧道、会话录制回放、多标签分屏。
