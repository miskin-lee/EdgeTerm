<p align="center">
  <img src="docs/icon.png" alt="EdgeTerm logo" width="128" height="128">
</p>

<h1 align="center">EdgeTerm</h1>

[English](README.md) | [简体中文](README.zh-CN.md)

一个小巧、轻量的终端 / SSH / SFTP / FTP / 串口客户端，用 **Rust + Tauri v2** 构建，前端为 React + xterm.js。Windows 和 macOS 安装包都不到 5 MB。

整个 SSH 栈是纯 Rust 的（russh），不依赖 libssh2、OpenSSL 或 pkg-config，因此在任何装了 Rust 工具链的机器上都能直接编译。

## 小巧轻量

| 安装包（v0.4.1） | 下载体积 |
| --- | --- |
| Windows x64 安装程序（`.exe`） | **3.9 MB** |
| macOS Apple Silicon（`.dmg`） | **4.7 MB** |
| Linux `.deb`（x64 / ARM64） | **5.3 MB** / **5.2 MB** |

安装后整个程序就是一个约 5 MB 的可执行文件，前端资源直接编译在里面，没有额外的资源目录要解压。能做到这一点是因为 EdgeTerm：

- 直接使用操作系统自带的 WebView 渲染界面（Windows 上是 WebView2，macOS 上是 WKWebView，Linux 上是 WebKitGTK），不像 Electron 类客户端那样自带一份 Chromium 和 Node.js 运行时；
- 后端是单个原生 Rust 二进制，开启 LTO、`opt-level = "s"`、`panic = "abort"` 并剥离符号；
- SSH、SFTP、FTP、串口和 ZMODEM 全部由 Rust crate 实现，不需要随包附带 OpenSSL、libssh2 等原生库。

更新同样小：应用内更新下载的就是这几 MB 的安装包。

唯一的运行时依赖就是系统 WebView：Windows 11 和更新过的 Windows 10 已经自带 WebView2（缺失时安装程序会自动下载），macOS 内置 WKWebView，`.deb` 则依赖发行版的 `libwebkit2gtk-4.1` 包。

## 功能

**会话类型**

| 类型 | 后端实现 | 说明 |
| --- | --- | --- |
| 本地 Shell | `portable-pty` | 真正的伪终端，支持窗口尺寸同步 |
| SSH | `russh` + `russh-sftp` | 密码 / 公钥 / ssh-agent 认证，SFTP 复用同一条连接，文件及文件夹流式传输 |
| SFTP | `russh` + `russh-sftp` | 基于 SSH 的纯文件传输会话，认证与主机密钥策略同 SSH，无终端，直接进入双栏文件管理器 |
| FTP | `suppaftp` | 密码或匿名认证，被动模式浏览，自动识别 UTF-8 / GBK 文件名，文件及文件夹双向流式传输 |
| 串口 | `serialport` | 波特率、数据位、停止位、校验、流控可配 |

SSH / SFTP / FTP 密码和 SSH 私钥口令保存在应用配置目录下仅当前系统用户可读的 `credentials.json` 中，不会返回给前端，也不会写入 `sessions.json`。因此重启 EdgeTerm 后可直接连接已保存的会话，不会触发 macOS Keychain 的电脑密码授权框。

标准 FTP 不加密凭据和文件内容，只应在可信网络中使用；需要传输安全时请使用 SSH / SFTP。

**界面**（对应 WindTerm 的布局）

- **时间戳 + 行号侧栏** —— WindTerm 最有辨识度的特性，每一行输出都带 `[HH:MM:SS.SSS]` 与累计行号，光标行高亮。可在 `Session` 菜单下切换四种显示模式。
- **丰富色彩渲染** —— 支持 ANSI 16 色、256 色和 24-bit 真彩，并为无 ANSI 样式的输出补充比 WindTerm 更丰富的暖色语义着色：提示符、选项、运算符与彩虹括号、`ls -l` 权限位与属主列、表头行、日志级别与 Kubernetes/Docker/systemd 状态、网络地址与域名、路径、Git diff、HTTP、JSON/YAML 等，并为错误/警告、diff 和表头行加淡色底带，为链接加下划线。
- **Session**（左侧）：保存的连接配置以可折叠的树形展示，双击连接。右击类型标题或分组可新建（可嵌套的）分组、重命名或删除分组；右击会话可连接、编辑、移动到其他分组或删除；新建会话时也可直接选择保存到哪个分组
- **Filer**（右侧）：文件浏览器。SSH 会话下自动切到 SFTP，可上传 / 下载文件和文件夹（支持拖拽上传）、新建目录、删除；其他终端会话下浏览本地文件系统
- **FTP / SFTP 工作区**：FTP 和 SFTP 会话使用独立的双栏文件管理器，左侧为远端服务器，右侧为本机，支持文件和整个文件夹的双向流式传输，以及新建、重命名和非递归删除
- **Sender**（底部）：批量发送。支持文本 / 十六进制、按行 / 按字符、重复次数、发送间隔、目标为当前会话或全部会话。保存的命令带作用域 —— 某个会话、Session 面板的某个分组、某类会话（串口 / SSH / Shell）或全部 —— Sender 只列出对当前标签页适用的命令，越具体的排越前
- 标签页、地址栏（`ssh › host:port`）、状态栏（窗口尺寸、光标 Ln/Ch、协议）。Session 面板标题栏带有作用于当前标签页的电源开关（也可用 **Session → Disconnect / Reconnect Session**）：点击断开连接，标签页和终端输出保留；再次点击即可原地重新连接

**数据导出与导入**

**Session → Export Data…** 把保存的会话及其分组、Sender 的常用命令和显示设置导出为一个 `.edgeterm` 文件（内容为 JSON）；**Session → Import Data…** 只接受 `.edgeterm` 文件，校验文件头后可在另一台机器或重装后把它合并回来（同 id 的条目覆盖本地，其余追加，不删除任何本地数据）。密码和私钥口令永远不会导出，导入的会话连接时需要重新输入。

**ZMODEM 传输**

本地 Shell、SSH 和串口终端会自动检测 ZMODEM 会话。在终端中执行 `rz` 后可选择一个或多个本地文件并发送；执行 `sz <文件>` 后可为每个接收文件选择保存位置。对端需要安装兼容的 `rz` / `sz` 实现（例如 `lrzsz`）。文件 I/O 和终端输出始终按原始二进制处理，并使用固定 1 MiB 应用层分块读写文件。传输过程中可通过 **Session → Cancel ZMODEM Transfer** 主动取消。

**快捷键**

| macOS | Windows / Linux | 动作 |
| --- | --- | --- |
| `⌘N` | `Alt+N` | 新建会话对话框 |
| `⌘W` | `Ctrl+Shift+W` | 关闭当前会话（会话仍在连接中时需二次确认） |
| `⌘F` / `⌘G` | `Ctrl+Shift+F` / `Ctrl+Shift+G` | 缓冲区内查找 / 下一个匹配 |
| `⌘K` | `Alt+K` | 清屏 |
| `⌘[` / `⌘]` | `Alt+[` / `Alt+]` | 切换到上一个 / 下一个已打开会话 |
| `⌘1`–`⌘9` | `Alt+1`–`Alt+9` | 切换到第 N 个标签 |
| `⌘⌥←` / `⌘⌥→` / `⌘⌥↓` | `Ctrl+Alt+←` / `Ctrl+Alt+→` / `Ctrl+Alt+↓` | 显示或隐藏 Session / Filer / Sender |
| `⌘C` / `⌘V` | `Ctrl+Shift+C` / `Ctrl+Shift+V` | 复制 / 粘贴（终端内） |
| `⌘A` | `Ctrl+Shift+A` | 全选终端缓冲区 |

特定场景下的按键：

- **搜索框** —— `Enter` / `Shift+Enter` 跳到下一个 / 上一个匹配，`Esc` 关闭搜索；在框内输入时上表的查找 / 下一个匹配快捷键同样有效。
- **命令补全弹窗** —— `↓` 进入列表，`↑` / `↓` 移动，`Enter` 或 `Tab` 采纳，`Esc` 关闭。弹窗只是显示、尚未选中任何一项时，其余按键仍然照常发给 Shell。
- **终端输出中的链接** —— macOS 下 `⌘`+点击，Windows / Linux 下 `Ctrl`+点击。

Windows / Linux 下，单独的 `Ctrl+字母` 始终原样发给 Shell（`Ctrl+C` 中断、`Ctrl+W` 删词、`Ctrl+K` 删到行尾）；`Alt+字母` 留给 readline 的 Meta 键位，只占用 readline 没有绑定的 `Alt+N` 和 `Alt+K`，因此编辑和搜索类快捷键改用 `Ctrl+Shift`。macOS 下 `Ctrl` 和 `Option` 从不被占用，只有 `⌘` 组合键是应用快捷键。

## 运行

```bash
npm install
npm run tauri dev      # 开发模式
npm run tauri build -- --no-bundle  # 仅编译验证，不生成安装包
npm run tauri build    # 生成当前平台的安装包
```

要求：Rust 1.80.1+、Node 20.19+（推荐 Node 22 LTS）。macOS 需要 Xcode Command Line Tools。

## 发布

Release 由 GitHub Actions 上的 [Release 工作流](.github/workflows/release.yml)构建并发布。每个 Release 包含：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | NSIS 安装程序（`.exe`） |
| macOS Apple Silicon | `.dmg`，以及应用内更新使用的 `.app.tar.gz` |
| Linux x64 / ARM64 | `.AppImage` 和 `.deb` |

已安装的版本启动时会检查最新 Release 并可在应用内直接更新；也可以随时用 **Help → Check for Updates…** 手动检查。

Release 不做 macOS 公证和 Windows Authenticode 代码签名，macOS 应用只使用 ad-hoc 签名，首次安装时系统仍可能弹出安全提示。

## 已知限制

- ZMODEM 暂不支持断点续传；中断后需要从头重新传输。
- 尚未实现：端口转发 / 隧道、会话录制回放、多标签分屏。
