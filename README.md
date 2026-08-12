# EdgeTerm

一个仿照 [WindTerm](https://github.com/kingToolbox/WindTerm) 的终端 / SSH / 串口客户端，用 **Rust + Tauri v2** 构建，前端为 React + xterm.js。

整个 SSH 栈是纯 Rust 的（russh），不依赖 libssh2、OpenSSL 或 pkg-config，因此在任何装了 Rust 工具链的机器上都能直接编译。

## 功能

**会话类型**

| 类型 | 后端实现 | 说明 |
| --- | --- | --- |
| 本地 Shell | `portable-pty` | 真正的伪终端，支持窗口尺寸同步 |
| SSH | `russh` + `russh-sftp` | 密码 / 公钥 / ssh-agent 认证，SFTP 复用同一条连接 |
| 串口 | `serialport` | 波特率、数据位、停止位、校验、流控可配 |

SSH 密码和私钥口令保存在应用配置目录下仅当前系统用户可读的 `credentials.json` 中，不会返回给前端，也不会写入 `sessions.json`。因此重启 EdgeTerm 后可直接连接已保存的会话，不会触发 macOS Keychain 的电脑密码授权框。

**界面**（对应 WindTerm 的布局）

- **时间戳 + 行号侧栏** —— WindTerm 最有辨识度的特性，每一行输出都带 `[HH:MM:SS.SSS]` 与累计行号，光标行高亮。可在 `Session` 菜单下切换四种显示模式。
- **丰富色彩渲染** —— 支持 ANSI 16 色、256 色和 24-bit 真彩，并为无 ANSI 样式的日志、网络地址、路径、Git diff、HTTP、JSON 等内容补充语义着色。
- **Filer**（左侧）：文件浏览器。SSH 会话下自动切到 SFTP，可上传 / 下载 / 新建目录 / 删除；其他会话下浏览本地文件系统
- **Session**（右侧）：保存的连接配置，按分组折叠，双击连接
- **Sender**（底部）：批量发送。支持文本 / 十六进制、按行 / 按字符、重复次数、发送间隔、目标为当前会话或全部会话
- 标签页、地址栏（`ssh › host:port`）、状态栏（窗口尺寸、光标 Ln/Ch、协议）

**快捷键**

| 快捷键 | 动作 |
| --- | --- |
| `⌘N` | 新建会话对话框 |
| `⌘W` | 关闭当前会话 |
| `⌘F` | 缓冲区内查找 |
| `⌘K` | 清屏 |
| `⌘1`–`⌘9` | 切换到第 N 个标签 |
| `⌘⌥←` / `⌘⌥→` / `⌘⌥↓` | 显示或隐藏 Filer / Session / Sender |
| `⌘C` / `⌘V` | 复制 / 粘贴（终端内） |

## 运行

```bash
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 打包
```

要求：Rust 1.77+、Node 20.19+（推荐 Node 22 LTS）。macOS 需要 Xcode Command Line Tools。

## Weekly Build

GitHub Actions 会在每周一北京时间 10:00（UTC 02:00）自动构建，也可在仓库的 **Actions → Weekly Build → Run workflow** 中手动触发。

当前生成以下原生安装包：

| 系统 | 架构 | Runner |
| --- | --- | --- |
| Linux | x64 | `ubuntu-22.04` |
| Linux | ARM64 | `ubuntu-22.04-arm` |
| Windows | x64 | `windows-2022` |
| macOS | Intel x64 | `macos-15-intel` |
| macOS | Apple Silicon ARM64 | `macos-15` |

构建完成后，进入对应的 workflow run，在页面底部 **Artifacts** 区域下载 `.deb`、`.rpm`、`.AppImage`、`.msi`、`.exe`、`.dmg` 等产物。工作流也支持命令行触发：

```bash
gh workflow run weekly-build.yml
gh run watch
```

Weekly Build 默认不做 macOS 公证或 Windows 代码签名，因此更适合内部测试和开发预览；对外分发前应配置平台签名证书。定时任务只会从 GitHub 默认分支运行，工作流文件见 [`.github/workflows/weekly-build.yml`](.github/workflows/weekly-build.yml)。

## 代码结构

```
src-tauri/src/
├── lib.rs           Tauri 应用装配与命令注册
├── commands.rs      所有 IPC 命令
├── model.rs         跨 IPC 的数据类型
├── store.rs         会话配置持久化
├── fs_local.rs      本地文件浏览
└── session/
    ├── mod.rs       会话管理器、命令通道、输出泵
    ├── local.rs     伪终端
    ├── ssh.rs       SSH 连接、认证、会话循环、SFTP
    └── serial.rs    串口

src/
├── App.tsx          整体布局、事件订阅、快捷键
├── actions.ts       会话打开流程
├── store.ts         zustand 状态
├── terminal.ts      xterm 封装 + 侧栏渲染
├── api.ts           IPC 封装
└── components/      各面板与控件
```

### 几个设计要点

**每个会话一个所有者任务。** 会话的 I/O 句柄（pty、SSH channel、串口）永远只被一个线程或 task 持有，外部通过 `mpsc` 发命令进去，输出以 Tauri 事件发出来。这样避免了在 `Send`/`Sync` 上和这些本质上非线程安全的句柄较劲。

**输出用 base64 传输。** 终端字节流里的多字节 UTF-8 序列会被读操作从中间切开，转成字符串会损坏数据。字节原样送到前端交给 xterm.js 解码。

**会话 id 由前端生成。** 前端先建好 xterm 实例再发起连接，否则 SSH 登录横幅这类在 `open_session` 返回之前就产生的输出会丢失。

**侧栏是原生 DOM，不走 React。** 输出滚动时它每帧都要更新，用 React state 会把整棵树重渲染。行高从 `.xterm-screen` 的高度除以行数得到，这个值缓存起来，逐帧同步时不再读取布局。

## 已知限制

- SFTP 传输目前是整文件读入内存，超大文件不适合。
- 已选择保存的密码和密钥口令会写入权限为 0600 的本地 `credentials.json`，方便重启后直接连接；它不具备系统凭据库的硬件级保护，对本机明文凭据存储有更高安全要求时请改用 ssh-agent / 无口令公钥认证。
- 主机密钥策略为 `accept-new`：首次连接自动记入 `~/.ssh/known_hosts`，密钥变更则拒绝连接。
- 尚未实现：端口转发 / 隧道、会话录制回放、多标签分屏。
