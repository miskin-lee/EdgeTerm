<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" alt="EdgeTerm" width="480">
  </picture>
</p>

[English](README.md) | [简体中文](README.zh-CN.md)

一个小巧、轻量、高性能的终端 / SSH / SFTP / FTP / 串口客户端，基于 **Rust + Tauri** 构建。

<img src="docs/screenshot-dark.png" alt="EdgeTerm 深色主题" width="100%">

<img src="docs/screenshot-light.png" alt="EdgeTerm 浅色主题" width="100%">

## 小巧轻量

| 安装包（v0.4.1） | 下载体积 |
| --- | --- |
| Windows x64 安装程序（`.exe`） | **3.9 MB** |
| macOS Apple Silicon（`.dmg`） | **4.7 MB** |
| Linux `.deb`（x64 / ARM64） | **5.3 MB** / **5.2 MB** |

## 功能

**会话类型**

| 类型 | 后端实现 | 说明 |
| --- | --- | --- |
| 本地 Shell | `portable-pty` | 真正的伪终端，支持窗口尺寸同步；Shell 字段可填带参数的命令行，如 `wsl.exe -d Ubuntu`、`pwsh -NoLogo` |
| SSH | `russh` + `russh-sftp` | 密码 / 公钥 / ssh-agent 认证，并支持服务端随后追加的 keyboard-interactive 二次验证（一次性验证码、推送确认等），SFTP 复用同一条连接，文件及文件夹流式传输 |
| SFTP | `russh` + `russh-sftp` | 基于 SSH 的纯文件传输会话，认证与主机密钥策略同 SSH，无终端，直接进入双栏文件管理器 |
| FTP | `suppaftp` | 密码或匿名认证，被动模式浏览，自动识别 UTF-8 / GBK 文件名，文件及文件夹双向流式传输 |
| 串口 | `serialport` | 波特率、数据位、停止位、校验、流控可配 |

**界面**
- **时间戳 + 行号侧栏** —— WindTerm 最有辨识度的特性，每一行输出都带 `[HH:MM:SS.SSS]` 与累计行号，光标行高亮。可在 `Session` 菜单下切换四种显示模式。
- **Session**（左侧）：保存的连接配置以可折叠的树形展示，双击连接。右击类型标题或分组可新建（可嵌套的）分组、重命名或删除分组；右击会话可连接、编辑、移动到其他分组或删除；新建会话时也可直接选择保存到哪个分组
- **Filer**（右侧）：文件浏览器。SSH 会话下自动切到 SFTP，可上传 / 下载文件和文件夹、新建目录、删除；其他终端会话下浏览本地文件系统。拖拽双向可用，面板任意位置都能放：从访达 / 资源管理器拖文件或文件夹进来，远程会话下上传到当前远程目录，本地会话下复制到当前显示的文件夹；把条目从窗口里拖到桌面或文件管理器即下载 —— 远程条目会先拷到本地，请按住不放等它准备好。收不下的拖放会说明原因，不会毫无反应
- **Sender**（底部）：发送文本 / 十六进制内容，可选行尾（无 / LF / CRLF），目标为当前会话或一次发给全部已打开的会话。保存的命令带作用域 —— 某个会话、Session 面板的某个分组、某类会话（串口 / SSH / Shell）或全部 —— Sender 只列出对当前标签页适用的命令，越具体的排越前

**显示设置**

**View → Display Settings…** 可设置界面与终端的字号、各自使用的字体，以及每个会话保留的回滚行数。软件本身不打包字体：字体留空即使用平台自带的字体栈，输入框会列出本机实际安装的字体，同时允许手动填写任意名称，自编译的 Nerd Font 也能用。

**命令补全**

开启 **Edit → Command Suggestions** 后，EdgeTerm 会记住在终端里执行过的命令，输入时弹窗列出历史匹配。`↓` 进入列表，`Enter` / `Tab` 采纳，`Esc` 关闭；弹窗尚未选中任何一项时，其余按键仍照常发给 Shell，**Edit → Clear Command History…** 可清空历史。

**标签活动**

后台标签会显示其中正在运行的内容，结束后保留高亮直到你切回去，方便跑长任务时先去忙别的。Claude Code、Codex、Gemini CLI、Aider 这类 AI 命令行工具则按另一套规则跟踪：它们的会话要一直开着，所以标签显示的是助手的每一轮——它在干活时显示运行中，把终端交还给你时显示已结束。

**数据导出与导入**

**Session → Export Data…** 把保存的会话及其分组、Sender 的常用命令和显示设置导出为一个 `.edgeterm` 文件（内容为 JSON）；**Session → Import Data…** 只接受 `.edgeterm` 文件。

**ZMODEM 与 XMODEM 传输**

本地 Shell、SSH 和串口终端会自动检测 ZMODEM 会话。在终端中执行 `rz` 后可选择一个或多个本地文件并发送；执行 `sz <文件>` 后可为每个接收文件选择保存位置。

XMODEM 没有可供检测的握手，需要从 **Session → File Transfer** 菜单手动发起。先在终端里启动对端（`rx <文件>`、`sx <文件>`、Bootloader 的 `loadx` 等），再选择 **Send via XMODEM…** 或 **Send via XMODEM-1K…** 并挑选要发送的文件，或选择 **Receive via XMODEM…** 并指定保存位置。接收支持 CRC 与校验和两种校验以及 128 字节 / 1 KiB 两种块长；发送在对端请求 CRC 时使用 CRC，否则退回 128 字节校验和块。XMODEM 不传文件长度，接收到的文件末块会保留发送方填充的 `^Z`。同一菜单的 **Cancel Transfer** 可中止任一协议的传输。

**鼠标复制 / 粘贴**

在终端里点击右键会弹出上下文菜单——Copy / Paste / Select All / Clear Buffer / Reveal Working Directory in Filer，并先选中指针所在的单词；中键粘贴。Windows 和 Linux 下可在 **Edit → Right Click** 改为 *Copy or Paste*，即控制台惯例：右键有选区时复制、没有选区时粘贴，不再弹菜单。macOS 始终使用菜单。vim、tmux（开启鼠标）、htop 等接管了鼠标的程序会收到这些点击；Windows / Linux 下按住 `Shift` 可绕过它们。

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

上表中的快捷键都可以在 **View → Keyboard Shortcuts…** 里重新绑定：点击某个命令的按键，再按下想要的组合即可，也可以清空让该命令不绑定任何按键；只有标签数字键和终端自己的复制 / 粘贴 / 全选例外，它们在应用看到之前就已由终端处理。**Help → Restore Default Settings…** 会把整张表恢复为缺省值。

## 发布

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | NSIS 安装程序（`.exe`） |
| macOS Apple Silicon | `.dmg`，以及应用内更新使用的 `.app.tar.gz` |
| Linux x64 / ARM64 | `.AppImage` 和 `.deb` |

已安装的版本启动时会检查最新 Release 并可在应用内直接更新；也可以随时用 **Help → Check for Updates…** 手动检查。

Release 不做 macOS 公证和 Windows Authenticode 代码签名，macOS 应用只使用 ad-hoc 签名，首次安装时系统仍可能弹出安全提示。


## 许可证

EdgeTerm 以 [GNU General Public License v3.0](LICENSE) 授权。分发的衍生作品必须以相同许可证发布并提供完整源码。
