# p2p-term — 跨 NAT 远程终端 spike

验证"EdgeTerm 内嵌 SSH server + iroh 做 NAT 穿透传输"这条路是否可行，
以及它的代价（体积、连接耗时、直连成功率）。**不是产品代码**，只为拍板用。

## 架构

```
serve  端                                            connect 端
iroh Endpoint（持久化密钥 → EndpointId 就是地址）  ←QUIC→  iroh Endpoint（临时密钥）
   accept_bi() → tokio::io::join(recv, send)                 open_bi()
   russh::server::run_stream  ── SSH 协议原样 ──  russh::client::connect_stream
   密码认证 → pty_request → shell_request → portable-pty 起本机 shell
```

- 协议层是标准 SSH（`russh`），和 EdgeTerm 现有 `session/ssh.rs` 同一套栈；
  服务端逻辑（`src/server.rs`）就是将来嵌进 EdgeTerm 的那部分。
- 传输层可换：`p2p` feature 走 iroh（打洞 + relay 回落，按公钥寻址）；
  `--tcp` / `host:port` 走裸 TCP（局域网直连，以及量体积用的对照组）。
- `russh` 的 `run_stream` / `connect_stream` 接受任意 `AsyncRead + AsyncWrite`，
  iroh 的 `SendStream` / `RecvStream` 直接实现了 tokio 的这两个 trait，中间零胶水。

## 用法

```bash
cargo build --release            # 带 iroh
cargo build --release --no-default-features   # 仅 TCP

# 机器 A（被控端）
./target/release/p2p-term serve --password 你的密码
#   → 首次运行在当前目录生成 p2p-term.key（0600），打印 EndpointId

# 机器 B（控制端，任意网络）
./target/release/p2p-term connect <EndpointId> --password 你的密码
#   跳过 DNS 发现、直接给地址（服务端 stderr 里有 relay URL 和本机 IP）：
./target/release/p2p-term connect <EndpointId> --relay https://aps1-1.relay.n0.iroh.link./ --addr 192.168.0.195:59164

# 局域网 / 对照组
./p2p-term serve --tcp 0.0.0.0:2222 --password x
./p2p-term connect 192.168.0.10:2222 --password x
```

stderr 会持续打印当前选中的路径（`relay` / `direct` + rtt），看打洞有没有成功就看这一行。
退出远端 shell（`exit`）即断开。密码也可用环境变量 `P2P_TERM_PASSWORD`。

## 实测（2026-08-29，macOS arm64，两端在同一台机器上）

| 项目 | 结果 |
|---|---|
| release 体积（项目同款 profile：`opt-level="s"` + lto + strip） | 仅 TCP **1.62 MB**；带 iroh **5.62 MB** → iroh 净增 **≈ 4.0 MB** |
| 服务端接入 home relay | `aps1-1.relay.n0.iroh.link`（新加坡） |
| 按 EndpointId 经 DNS/pkarr 发现并连上 | 6–7 s（含地址查询）；给定 relay URL 则 0.6 s |
| relay 路径 rtt | 220–390 ms（本机 ↔ 新加坡 ↔ 本机） |
| 直连升级 | 连上后 2–4 s 内自动切到 direct，rtt 0.2–0.5 ms |
| SSH 认证 / PTY / shell / resize / 退出 | 全部正常 |

注意：服务端 `online()` 之后地址发布到 DNS 需要几秒；客户端连得太快会报
`No addressing information available`。产品里应在 UI 上等发布完成再显示"可连接"，
或把 relay URL 一并编进连接串（`--relay` 那条路），两者都做最稳。

## 遗留问题

- 前两轮测试中服务端出现过数条 `incoming connection … authentication failed`，
  第三轮没有复现，疑似前次测试进程的残留连接尝试；日志现已带来源地址，再出现可定位。
- 两端真的在不同 NAT 后面的直连成功率、以及国内到 n0 公共 relay 的延迟，**还需用两台真机测**：
  把 release 二进制拷到另一台机器跑 `connect` 即可，看 stderr 的 `paths:` 行。
- 中继全部是 n0 的公共节点；正式做要评估自建 `iroh-relay`（国内一台）。
- SSH host key 目前每个会话随机生成（客户端不校验，因为 iroh 层已按 EndpointId 认证过对端）；
  嵌进 EdgeTerm 时应持久化，或在 iroh 层做客户端 EndpointId 白名单（配对）。
- 尚未做：附着到已有会话（多端同步输入）、只读、踢人。这些在 SSH 之上加 `exec attach <id>` 即可，
  与传输层无关。
