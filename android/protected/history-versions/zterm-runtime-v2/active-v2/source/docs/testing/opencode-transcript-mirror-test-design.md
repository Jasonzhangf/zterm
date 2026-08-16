# opencode transcript mirror test design

## Scope

Feature `terminal.opencode_transcript` owns: opencode 插件数据导出（transcript 快照文件）、daemon 只读服务（HTTP 数据通道）、client 快捷栏开关 + transcript 历史区投影。终端 buffer truth（mirror store / sparse buffer / renderer commit）与 tmux capture 语义 out of scope —— 本功能不得触碰。

## Lifecycle

`opencode 事件 -> 插件内存 transcript -> 原子写快照文件 -> daemon HTTP 只读 -> client 轮询(since=version) -> 虚拟历史区投影 -> 快捷栏开关控制显示`。

开关有效性 = daemon 报告的 pane 物理事实（`pane_current_command == opencode` 且文件存在且新鲜）。数据面与控制面无耦合：开关不改变 daemon 数据产出，daemon 状态不随开关变化。

## Required Tests

### L1-插件纯逻辑（脱离 opencode 进程的纯函数）

- transcript 组装：`message.updated` 维护 messageID→role；`message.part.updated` 完整快照（delta 为空/缺失）才缓存，流式 delta 跳过
- 空 part 先例不抢占去重：textLen=0 快照到达后完整快照仍写入
- role 时序：assistant 的 part 先于 message.updated 到达，pending 缓存后 role 确定 flush
- synthetic / ignored part 过滤
- active session 切换：切换后文件整体重写为新 session 全量
- 原子写：tmp + rename、目录创建、写失败显式报错（不吞异常、不残留半截 tmp 目标文件）
- `TMUX_PANE` 缺失时不写文件并显式 debug

### L1-daemon 只读服务

- pane 文件路径映射（pane id 不允许路径穿越：`../`、绝对路径注入必须拒绝或显式不可用）
- version 语义：since=mtime 匹配 → 空 lines；不匹配 → 全量 lines
- fresh 判定：文件存在+mtime 新鲜 / 文件过期 / 文件缺失 / 非 opencode pane 四种状态显式区分
- HTTP 路由：`GET /api/v1/transcript?pane=&since=` 正常全量/增量；非法参数显式 4xx；服务失败不改变 mirror/transport 生命周期
- 反向红测：daemon 不得写 mirror store、不得因 transcript 失败 fallback 到旧文件或 capture

### L1-client 投影

- 开关状态机：禁用（非 opencode pane / 文件缺失 / 过期）/ 可用 / 启用
- 轮询 since 语义：版本不匹配全量替换、匹配无变更；行序列去重
- 虚拟历史区：上滚先进 transcript 区，到底衔接 mirror reading；transcript 行不进入 sparse buffer
- 反向红测：transcript 行不得写入 `resource.client_sparse_buffer`；开关切换不污染 buffer 行号空间

### L2 daemon/tmux 真回环

- 真实 tmux 启动 opencode TUI（>=1.18）+ 安装插件，验证：
  1. 文件按 `TMUX_PANE` 生成、内容与 opencode 会话一致（user/assistant 分块、完整文本）
  2. 原子写生效（抓取重写瞬间无半截文件）
  3. daemon HTTP 读取内容与文件一致
  4. opencode 退出后 fresh=false
  5. 两个 pane 各跑一个 opencode，文件与 pane 精确隔离
- 命令：扩展 `daemon:mirror:close-loop` 路径，case 输出含 tmux oracle、文件内容、HTTP 响应

### L3 本地 client runtime gate

- transcript 请求/响应处理（client 侧 parser：全量替换/增量空响应/错误响应）
- projection 输入正确（行序列传给渲染区）

### L4 UI 行为 gate

- 快捷栏开关：opencode pane 可点开、非 opencode pane 禁用并提示
- 历史区滚动：上滚进 transcript、到底进 mirror reading、下滚回 follow
- 开关切换不污染 terminal buffer 显示

### L5 真机 smoke

- 构建 APK + OTA 升级通道（buildNumber 变化必须同步发布），真机验证开关 + 历史显示；无设备显式报告缺口

## Verification Layers

- L0: `test:feature-registry` / `resource-registry-truth` / `module-registry-truth` / `module-import-graph-truth` / `tsc --noEmit`
- L1: 插件纯逻辑测试文件、`src/server/opencode-transcript-reader.test.ts`、client projection 测试
- L2: daemon/tmux 真回环（真实 opencode 1.18+）
- L3: client transport/runtime gate
- L4: TerminalPage / 快捷栏 UI 测试
- L5: 真机 smoke + OTA

## Non-goals

- 不修改 mirror store / buffer sync / capture cadence 任何语义
- 不做 transcript 的 daemon 侧解析、缓存、客户端状态机
- 不兼容 opencode < 1.18（安装脚本显式检测版本并提示）
- 不提供"让 TUI 写 tmux scrollback"的替代路径（已论证不可行）
