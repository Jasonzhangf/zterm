# 2026-08-07 opencode transcript mirror truth

## Purpose

本决策定义 opencode TUI 对话历史如何进入 zterm 移动端 mirror 的架构契约：数据源（opencode 插件导出）、wire（文件）、数据通道（daemon 只读服务）、投影（client transcript 历史区）。它独立于 terminal buffer/render truth，独立于 daemon mirror store，独立于 remote window stream。

## 背景（已实证）

- opencode TUI 在 tmux 内使用 alternate screen（opentui 默认）：`alternate_on=1`、`history_size=0`，tmux scrollback 完全为空，`capture-pane -S -N` 拿不到任何本屏以外历史。
- `OTUI_USE_ALTERNATE_SCREEN=false`（main-screen）同样不产生 history：opentui 每帧用 CUP 绝对寻址重绘，无换行滚动，tmux 历史永不增长。
- `opencode run`（split-footer + capture-stdout + writeToScrollback）是唯一把内容写入真实 scrollback 的路径，但不是完整 TUI。
- opencode 插件机制（`Hooks.event` + `PluginInput.client`）可订阅 `message.part.updated`（完整快照语义：流式期间发 `message.part.delta`，结束时发带完整 text 的 `message.part.updated`），并用 SDK client 拉历史。已在 opencode 1.18.14 上对 TUI 与 run 两种模式实测通过。
- opencode 1.14.39 及更早的 TUI 模式下插件 `hooks.event` 收不到任何事件（run 模式正常），本功能要求 **opencode >= 1.18**。

结论：无法通过"让 TUI 写 tmux scrollback"解决问题；正确路径是 opencode 数据导出 + 独立数据通道 + client 独立投影。

## 分层架构

```text
opencode 插件（opencode 进程内，数据导出）
   → ~/.zterm/opencode-mirror/<tmux-pane-id>.txt（wire：原子写全量快照）
   → daemon 只读服务（数据通道：HTTP GET /api/v1/transcript）
   → client transcript 投影（开关 + 行序列 + renderer 虚拟历史区）
```

四层单向依赖，禁止越层。任何一层不得替其它层维护第二份状态机。

### 层 1：opencode 插件（数据导出，独立于 zterm runtime）

- 代码随 zterm 仓库分发（`android/opencode-plugin/zterm-mirror/`），运行在 opencode 进程内，由 opencode 插件系统加载。
- 职责：订阅 opencode 事件，维护 active session 全量 transcript 内存，原子写文件。
- **不 import zterm 任何代码，不持有 zterm 状态，不感知 zterm daemon / client 存在**。它是"opencode truth 的只读导出器"。
- 开启条件：`ZTERM_MIRROR_FILE` 环境变量存在（安装脚本负责注入）。未设置则不写，插件零开销。
- 文件路径：`<mirror-dir>/<tmux-pane-id>.txt`。
  - `<tmux-pane-id>` 来自 `env.TMUX_PANE`（tmux 注入子进程的物理事实），与 daemon 的 tmux pane target 用同一事实对齐。
  - `<mirror-dir>` 约定 `$ZTERM_OPENCODE_MIRROR_DIR` 或默认 `~/.zterm/opencode-mirror`。
  - `TMUX_PANE` 不存在（非 tmux 启动）→ 插件不写文件，显式 debug 记录。
  - 多个 opencode 进程 / 多个 pane 并行互不冲突（按 pane id 隔离）。
- 写入协议：**全量快照 + 原子写**（tmp 文件 + rename），每次消息变更后重写整个文件。文件永远是完整 transcript，daemon / client 永远读到完整快照，无增量拼接、无半截文件。
- 内容格式：纯文本行，`── user ──` / `── assistant ──` 分块，行内无 ANSI。每行即一个投影行。
- 事件协议（已实测）：
  - `message.updated`：维护 `messageID -> role` 映射（part 无 role 字段）。
  - `message.part.updated`：仅 `type=text` 且完整快照（`delta` 为空/缺失）时缓存文本；流式 `delta` 事件跳过。
  - 空文本快照（textLen=0）先到、完整快照后到的顺序：**先验证文本非空，再标记已写**，防止空 part 抢占去重标记。
  - role 时序：assistant 的 `message.updated` 晚于 part 到达，按 messageID 缓存 pending，role 确定后 flush。
  - active session 切换（TUI 内切 session）：插件跟踪当前 active session，文件只写 active session 的全量 transcript；切换即整体重写。

### 层 2：文件（wire）

- 文件即 truth 快照（全量，非日志）。
- 新鲜度事实：文件 mtime。opencode 进程存活 ⇒ 插件存活 ⇒ 文件会随消息更新；opencode 退出 ⇒ 文件停止更新（mtime 冻结）。
- 文件归属 `~/.zterm/opencode-mirror/`，属于 daemon runtime home 管理的运行时产物，不属于 opencode 仓库、不属于 zterm 仓库提交物。

### 层 3：daemon 只读服务（数据通道）

新资源：`resource.opencode_transcript`（daemon 侧，唯一 owner `daemon.opencode_transcript_reader`）。

- 职责：
  - 按 pane id 只读 `~/.zterm/opencode-mirror/<pane-id>.txt`。
  - 提供 `GET /api/v1/transcript?pane=<paneId>&since=<version>`：
    - 返回 `{ pane, opencode: boolean, fileExists: boolean, fresh: boolean, version, lines[] }`。
    - `opencode` 事实来自 daemon 已采集的 pane 物理事实（`#{pane_current_command} == "opencode"`）。
    - `version` 为文件 mtime；`since` 不匹配时返回全量 `lines`，匹配时返回空数组（增量语义由版本比对实现，服务本身无状态）。
    - `fresh` 由文件存在 + mtime 新鲜度判定（opencode 进程存活观测的近似）。
  - 纯只读：不写文件、不解析对话语义、不缓存行内容状态（每次请求读文件）、不改变 mirror store / mirror head / index / revision / capture cadence。
- **禁止**：把 transcript 行写入 daemon mirror store；用 transcript 改变任何 tmux 操作；把 transcript 用于 daemon 内部客户端决策；持有 per-client 状态机；因 transcript 服务失败改变 transport / mirror 生命周期。
- HTTP 而非 mux channel 的理由：低频（消息级）只读数据，复用 `daemon.attachment_delivery` 的 `terminal-http-runtime` 模式，不污染 mux 控制/业务线（mux 只允许 target/channel 帧）。

### 层 4：client transcript 投影

新资源：`resource.client_opencode_transcript_projection`（client 侧，唯一 owner `client.opencode_transcript_projection`）。

- 职责：
  - 快捷栏开关（client truth：开关状态只属于客户端 UI）。
  - 开关有效性由 daemon 报告的 pane 物理事实决定：`opencode=true` 且文件存在时才可启用；否则开关禁用并显示"仅 opencode session 可用"。
  - 订阅 transcript 数据（轮询 `since=version`），维护本地 transcript 行序列。
  - renderer 虚拟历史区：transcript 行作为可见区上方的虚拟滚动区（上滚先进 transcript 历史，到底后进入 mirror 的 scrollback/reading）。
- **禁止**：把 transcript 行写入 `resource.client_sparse_buffer`；改变 mirror absolute index / head 语义；用 transcript 驱动 daemon；在非 opencode pane 上启用开关；把"transcript 可用"投影成终端 buffer truth。
- 显示语义：transcript 区是**独立投影**，不是 buffer 合并。renderer 只把 transcript 区作为可见窗口顶部的虚拟行（own 虚拟行 id），不触碰 mirror 行号空间。

## 数据与控制分离

- 数据面：`opencode → 文件 → daemon 只读服务 → client 投影`。daemon 只传字节与版本事实，不解释、不决策。
- 控制面：开关是 client truth；opencode 检测是 daemon 物理 pane 观察；两者通过"开关有效条件 = daemon 报告的物理事实"解耦，任何一层不持有另一层的状态。
- daemon 不因 client 开关改变任何 capture / mirror / transport 行为；client 开关不改变 daemon 数据产出。
- 插件开关（`ZTERM_MIRROR_FILE`）是部署事实（安装脚本），与 client 快捷栏开关语义不同层，互不替代。

## 不变量

1. transcript 行绝不进入 `resource.mirror_store`；mirror 冻结为 tmux truth 唯一（single-capture → canonicalize → mirror store 不变）。
2. transcript 不影响 mirror absolute index / head / latestEndIndex / revision / capture cadence。
3. daemon transcript 服务纯只读、无状态：无 per-client/per-pane 订阅状态机。
4. 开关是 client truth；daemon 不做启用/禁用决策。
5. 文件原子写（tmp + rename），daemon/client 永不读半截。
6. 新鲜度事实：opencode 进程存活 = 插件存活 = 文件更新；文件 mtime 冻结（opencode 退出）⇒ daemon 报 `fresh=false`，client 禁用开关或显示"历史截至"。
7. 多 opencode pane 按 `TMUX_PANE` 隔离并行。
8. 无 fallback：opencode 未运行 / 文件缺失 / 文件过期 → 显式不可用，禁止用旧文件、猜测内容或镜像 capture 兜底。
9. 插件是数据导出器，不 import zterm runtime；zterm runtime 不 import 插件。

## 反模式清单

- 把 transcript 行拼进 daemon mirror store（违反 single-capture 冻结）
- daemon 解析对话语义 / 维护 per-client transcript 状态
- client 把 transcript 写入 sparse buffer 或用 transcript 驱动 buffer/daemon
- 非 opencode pane 上启用开关或猜测内容
- 增量 append 文件 + 启动补全（重复、时序依赖、半截）
- 插件内嵌 zterm 代码或 daemon 反向感知插件

## 版本要求

- opencode >= 1.18（1.14.x TUI 模式插件事件不可用，已实测）。
- 安装脚本必须检测 opencode 版本并显式提示，不静默降级。

## 注册清单（本决策落地时必须同时完成）

- `docs/feature-registry.json`：新增 `terminal.opencode_transcript`
- `docs/resource-registry.json`：新增 `resource.opencode_transcript`、`resource.client_opencode_transcript_projection`
- `docs/module-registry.json`：新增 daemon 模块 `daemon.opencode_transcript_reader`、client 模块归属
- `docs/edge-registry.json`：新增跨模块边
- `docs/resource-map.md` / `docs/function-map.md`：注册资源关系
- `docs/testing/opencode-transcript-mirror-test-design.md`：测试设计（见测试方案）
- `AGENTS.md`：真源索引补充

## 测试方案

按 `terminal-buffer-truth` skill 的 L0–L5 阶梯执行，影响面覆盖 daemon 只读服务、client 投影、插件导出，各层对应 gate：

- **L0 静态/架构 gate**：`test:feature-registry`、`resource-registry-truth`、`module-registry-truth`、`module-import-graph-truth`、`tsc --noEmit`。
- **L1 owner 单测**：
  - 插件纯逻辑（脱离 opencode 进程的纯函数单元）：transcript 组装（role 映射、pending flush、空 part 去重顺序、synthetic/ignored 过滤、active session 切换）、原子写（tmp+rename、目录创建、异常路径）。
  - daemon `opencode_transcript_reader`：pane 文件路径映射、mtime 版本语义（since 匹配/不匹配）、fresh 判定（存在/过期/缺失）、HTTP 路由（非 opencode pane、文件缺失、文件过期、正常全量/增量）、路径穿越防护。
  - client 投影：开关状态机（禁用/可用/启用）、轮询 since 语义、行序列去重、虚拟区滚动边界（transcript 顶部/与 mirror reading 的衔接）、非 opencode pane 开关禁用。
- **L2 daemon/tmux 真回环**：真实 tmux 启动 opencode TUI + 安装插件，验证：文件生成与原子写、`TMUX_PANE` 对齐、daemon HTTP 读取内容与 opencode 会话一致、opencode 退出后 fresh=false、多 pane 并行隔离。命令沿用 `daemon:mirror:close-loop` 模式的扩展。
- **L3 本地 client runtime gate**：client transport/runtime 覆盖 transcript 请求/响应处理；`opencode_transcript_projection` 的渲染输入正确。
- **L4 UI 行为 gate**：快捷栏开关交互（可用/禁用态）、虚拟历史区滚动（上滚进 transcript、到底进 mirror reading）、开关切换不污染 buffer。
- **L5 真机 smoke**：构建 APK 升级通道（buildNumber 变化必须同步 OTA），真机验证开关 + 历史显示；无设备时显式报告 L5 缺口。

**红测（反向）必锁**：transcript 行不得进入 mirror store / sparse buffer（registry forbidden 扫描 + 行为测试）；daemon 读文件失败不得 fallback 到旧文件或镜像 capture；非 opencode pane 开关必须禁用；插件写文件失败必须显式报错不吞异常。
