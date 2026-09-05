# Terminal physical boundary closeout plan

日期：2026-09-05

执行 worktree：`playground/tbc-closeout-0905`
执行分支：`codex/terminal-physical-boundary-closeout-20260905`
执行基线：`origin/main`，实现候选基线为 `f8f89a70edf3c33a72020126c2ad2169d3aebbe8`
审计基线：`0285675ea3bc`

## 执行状态（2026-09-05）

状态：完成。实现、L0-L5、AGY review、candidate commit、protected PR
merge、远端 `main` push receipt 和三通道 OTA 验证均已闭环。

交付 receipt：

- candidate commit：
  `afa67a7300993ac8f8d435966d6298d81a7c9da5`
  (`refactor: close terminal physical boundaries`)；
- protected PR：`#37`，状态 `MERGED`；
- merge commit / 远端 `refs/heads/main`：
  `df3c547c9a14dfa7b2d3e35ca64b3e6cd2ae3abd`；
- candidate 是远端 `main` 的祖先；
- PR required checks 6/6 PASS：Android typecheck/regression、App repo
  layout、Cordis v2、daemon package、Mac desktop、Windows desktop；
- AGY controller：`verdict=pass`、`findings=[]`、`exitCode=0`。

本轮从 `f8f89a70edf3c33a72020126c2ad2169d3aebbe8` 开始。该基线已经包含
PR #36（`fix(daemon): bound range publishing`）：

- range response 已进入 `daemon.buffer_publisher` 的独立 FIFO lane；
- range 保留 request range、`requestSentAt` 和同 revision frame split；
- shared physical transport 已统一预算并在 logical subscribers 间 round-robin；
- handler 不再直接向 transport 裸发 range 正文。

因此本候选不重复修改 publisher。当前 residual 实现是：

- `daemon.input_queue` 新增 detached backend intent 入口；interactive、schedule、
  autoCommand、terminal image paste、file attach 共用唯一物理 ordering queue。
- `terminal-control-runtime` 只保留 selected backend 的最低层
  `writeBackendInputGroup`，旧同步 `writeToTmuxSession` /
  `writeToLiveMirror` 旁路已物理删除。
- detached schedule/file intent 不要求 ready mirror；interactive live input 仍要求
  ready mirror；每个 intent 的 payload/Enter 边界和 typed backend 均保留。
- renderer follow/reading/render bottom 与 follow-scroll transition 已收进现有
  `use-terminal-renderer-window` owner；`TerminalView` 只消费 controller API，
  不再直接持有或写入 follow-scroll ref。
- 真机 verifier 不再点击任意 saved connection，不再把无 `adb reverse` 的
  `127.0.0.1` 写成设备目标；它选择当前 Tailscale device-reachable host，
  只更新精确 endpoint，并在会抢走 ImeAnchor focus 的 UI dump 前注入输入。

本轮未新增 mux、frame assembly、repair ledger、generation、trace 或 control
center 实现；这些能力已在当前 `main` 存在并由 terminal contracts 覆盖。当前
daemon control gateway 已从 typed schedule/tmux envelope 读取
`idempotencyKey` 并传给 control center。不能把这些既有能力描述为本候选新增。

已完成证据：

- L0：Android type-check PASS；feature/resource/module/edge/import/mainline gates
  13 files、103/103 PASS；`git diff --check` PASS。
- L1：完整 terminal contracts 56 files、879/879 PASS；其中包含 publisher
  range FIFO/fairness、input queue、renderer、mux transport、frame assembly、
  repair、generation、trace 和 control center 正反 gate。
- L2：`pnpm --dir android run daemon:mirror:close-loop` 9/9 PASS：
  codex/top/vim、initial sync、local/long/external input、daemon restart、
  schedule fire；strict replay/audit PASS。证据：
  `android/evidence/daemon-mirror/2026-09-05/summary.json`。
- L3：Mac client 23 files、167/167 PASS；Mac type-check PASS。Android
  SessionContext/buffer/renderer 主链包含在 terminal contracts。
- L4/L5：Android 2917 已覆盖安装到 `100.104.163.65:5555`，未 uninstall/
  clear；`firstInstallTime` 保持 `2026-06-16 12:30:58`，dataDir 保持
  `/data/user/0/com.zterm.android`。真机 evidence
  `android/evidence/real-device/2026-09-05-050311/summary.json` 为 PASS：
  active session 的 client input send、daemon input receive/write、buffer
  head/apply、render commit 全部为 true，local truth anomaly 为 0。
- L5 build：versionName `0.1.3.2917`，versionCode `1100029170`，
  APK `android/update-dist/zterm-0.1.3.2917.apk`，SHA-256
  `58a72e058b3fd1652667cc61abd9d0ea39905311b8c9b538f57f214ddfeabad9`；
  rollback `0.1.3.2917.1` 已生成并通过 update bundle verify。
- APK 内 manifest 已由 `apkanalyzer` 读取确认：
  versionName `0.1.3.2917`、versionCode `1100029170`。
- daemon candidate release 已安装并恢复为正常 LaunchAgent：
  installed/release `runtime/server.cjs` SHA-256 均为
  `178c962f1cc76875597cd1b01fd0c8f6e3dba019e2bfe3a0274dbf3fe7ba1995`；
  `/health` PASS。真机 debug 只在显式前台验证进程中临时开启，结束后已撤销。
- OTA stable channel `0.1.3.2917` 已完成三通道验证：
  `127.0.0.1:3333`、Tailscale `100.66.1.82:3333`、Public Relay
  `relay.codewhisper.cc:18443/relay` 的 manifest 均返回 2917；三个通道
  APK GET/HEAD 均成功，下载 SHA-256 均为
  `58a72e058b3fd1652667cc61abd9d0ea39905311b8c9b538f57f214ddfeabad9`。

证据范围说明：physical channel fairness 复用 PR #36 的确定性回归；本轮没有
新增真实多-channel 弱网/外部网络压力实验，因此不把 879 项 contract tests
描述为真实多设备压力验收。未穷尽 Android/shared/daemon/Mac 主链之外的平台
和业务模块。

## 目标与完成信号

收口以下唯一数据链：

```text
backend/tmux -> mirror/store -> buffer publisher -> physical target transport
-> mux channel -> frame assembly -> sparse buffer -> renderer window -> DOM/UI
```

完成必须同时证明：

- range/live 正文都经过 `daemon.buffer_publisher`；range 保留 FIFO、范围、request identity 和 `requestSentAt`。
- 一个 physical socket 统一总发送预算；logical channel 以有界轮次公平发送。
- interactive、schedule、autoCommand、paste、file attach 都经唯一 `daemon.input_queue`，保持 string-only 和显式失败。
- mirror cadence 不被 subscriber backpressure 降级；adaptive width 只有唯一 lease owner 可请求 tmux 重排，geometry 只来自 readback。
- `resource.renderer_window` 独占 follow/reading/renderBottomIndex/visible range；`TerminalView` 只做 DOM 投影、测量和事件采集。
- mux、frame assembly、repair、generation、trace、control idempotency 的正反测试和真实入口证据齐全。
- 适用 L0-L5、AGY review、candidate commit、protected merge、push 和远端 receipt 均有证据；缺失层级明确列为 blocker。

## 范围与边界

In scope：Android/shared/daemon terminal 主链及其 owner/map/test/doc gate；审计指出的正文旁路、共享连接拥塞、backend write 旁路、DOM window ownership，以及审计后半段 repair/generation/trace/control ingress。

Out of scope：`../wterm` runtime 源码、未被本链影响的平台业务、清理其他
worker 的 worktree 或主 checkout dirty。

硬约束：不新增第二套 store/lifecycle/fallback；控制面与 terminal/file/media body 物理隔离；所有 terminal 改动先完成架构/map/owner 对齐，再红测、最小实现、正反验证；禁止 destructive Git cleanup、`pkill`、`killall`、`kill $(...)`、`xargs kill`。

## Owner 与技术方案

| 功能 | 唯一 owner | 方案 |
|---|---|---|
| mirror truth/cadence | `resource.mirror_store` / mirror runtime | single-capture、canonicalize、readback；不持有 client policy |
| 正文发布 | `resource.daemon_buffer_publisher` | live pending-latest 与 range FIFO 分开；publisher 统一 backpressure/frame split |
| physical transport | `resource.daemon_target_transport` | socket、认证、generation、总预算；不持有 client 状态 |
| mux lifecycle | `resource.daemon_channel_mux` | typed target/channel envelope；open/close 原子清理 |
| backend write | `resource.daemon_input_queue` + selected backend | 所有写串行化，错误显式返回 |
| frame/buffer | `resource.client_buffer_frame_assembly` + `client_sparse_buffer` | 完整 frame 一次 apply；repair 按绝对范围记录 |
| window | `resource.renderer_window` | follow、reading、bottom、visible range、transition |
| DOM | `client.dom_renderer` | TerminalView 投影、测量、事件；不持有 window truth |
| control | `daemon.control_gateway -> daemon.control_center` | typed capability、deadline、稳定 idempotency/correlation |

重点改动文件按实际 owner 收敛，预计涉及 `android/src/server/daemon-buffer-publisher-runtime*`、`daemon-input-queue-runtime*`、schedule/file/mirror/server wiring、`use-terminal-renderer-window*`、`TerminalView*`、mux/frame/repair/control 对应实现与测试；不得凭 grep 跨层补丁。

## 实施步骤

1. **基线与映射**：在本 worktree fetch/核对最新 `origin/main`；读取 architecture、audit、resource/module/edge/function map、decisions、dev workflow、terminal-buffer-truth；记录 dirty、owner、allowed/forbidden paths。
2. **range 与 physical send**：先补 range FIFO/request identity/frame split/backpressure/send-failure 红测；实现 shared physical total budget 与 channel fairness；禁止 handler 裸发正文。
3. **backend input**：盘点 interactive/schedule/autoCommand/paste/file attach；先补交叉 ordering、dispose、stale/duplicate 红测，再让所有写进入 input queue，保持独立 Enter 边界。
4. **mirror/adaptive width**：补 healthy subscriber cadence、slow publisher、最窄 adaptive lease、expiry/release、readback geometry 测试；执行真实 shell、`top`、`vim`、external writer 回环。
5. **renderer window**：把 TerminalView 的 follow/reading/bottom/transition ref 与 setter 封装进既有 hook/controller；不新增 store；补 remount、preview、IME/layout、gap、late publish、source-to-DOM gate。
6. **mux 与审计后半段**：验证 typed mux wire、原子 open/close；补 frame assembly、repair ledger（accepted/dispatched/fulfilled/superseded/blocked）、generation rejection、bounded metadata-only trace 和 replay 反测。
7. **control ingress**：区分必须幂等与不承诺幂等的能力；需要重试去重的操作沿 typed control envelope 传稳定 `idempotencyKey`；控制失败显式返回，body 不进入 control center。
8. **分层验收**：已完成。L0→L5 evidence、rollback/update bundle、三通道
   OTA GET/HEAD/hash 均已验证。
9. **review 与交付**：已完成。AGY PASS；candidate `afa67a73` 经 PR #37
   合并为 `df3c547c`；远端 `main`、candidate ancestry 和 required checks
   已复核。

## 验证矩阵

| 层级 | 必须证明 | 证据 |
|---|---|---|
| L0 | map/owner/import/forbidden/type 无破坏 | feature registry、tsc、diff check、扫描 |
| L1 | owner 正反语义 | 定向 Vitest：publisher/input/renderer/mux/frame/repair/control |
| L2 | daemon/tmux 真回环 | `pnpm --dir android run daemon:mirror:close-loop`、tmux oracle、daemon events、replay/strict summary |
| L3 | 本地 client transport/runtime | Mac test/type-check；Android SessionContext/buffer/TerminalView 入口 gate |
| L4 | app shell/UI 行为 | 适用 Android/Mac UI gate、source-to-DOM evidence |
| L5 | packaged/device smoke | Android build + APK version/SHA；在线设备或明确 blocker；Mac packaged/dev smoke |

每轮记录命令、结果、证据路径和 blocker；失败必须修复后重跑受影响 gate。单测、build、health、安装、review 或 source merge 都不能单独宣称产品闭环。

## 风险与规避

- 迁移冲突：只在本 worktree 处理，保护主 checkout/其他 worktree；不得 reset/restore/stash。
- range 被 live 合并吞掉：使用独立 FIFO 和 request identity，写正反测试。
- shared socket 饥饿：总预算归 physical owner，每轮每 subscriber 有界机会。
- queue 旁路：生产调用扫描 + 交叉 ordering 测试；旧 API 无引用后才物理删除。
- DOM 与 renderer 双真源：源码 gate 禁止 ref/setter 出现在 TerminalView。
- 低层绿掩盖真实链路：严格按 L0-L5 报告，缺设备/服务/权限即保留 blocker。
- review/Git 保护失败：review PASS 前不 commit；集成通过独立 protected branch/worktree 完成。

## 完成定义（DoD）

代码、文档、maps、tests 与 owner 一致；Phase 1-7 的适用项有正反证据；
L0-L5 PASS；AGY review PASS；candidate 已 commit；`main` 已受保护合并并
push；三通道 OTA 已验证；远端 `main` SHA、祖先关系、review/merge receipt、
设备和 daemon/tmux evidence 均可复核。

剩余风险不是未完成项：真实多-channel 弱网压力数值尚未量化；本任务只证明
共享物理预算与 logical subscriber round-robin 的确定性契约，以及真实
daemon/tmux、Mac client、Android 真机主链。后续若要声明特定并发延迟 SLO，
必须另开性能任务并记录网络、channel 数、payload、p50/p95/p99。

本文件是本任务长程计划唯一真源；执行时不再生成新的同任务 prompt。
