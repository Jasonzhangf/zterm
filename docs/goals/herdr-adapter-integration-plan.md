# zterm Herdr adapter integration plan

## 目标与验收标准

将官方 Herdr 作为 zterm 的显式兼容 backend，与 tmux 并存；只映射 zterm 使用的单 session terminal surface，不引入 Herdr pane split、tab、workspace UI 模型。

验收标准：

- tmux 现有 zterm 黑盒契约保持 100% parity oracle。
- Herdr terminal session 的 list/create/close/rename、output、input、resize、reconnect、multi-client mirror 能映射到 zterm canonical contract。
- Herdr ANSI frame 经唯一 adapter canonicalizer 生成 zterm rows/cells/cursor/geometry/absolute range/revision；不把 Herdr seq 直接当 zterm revision。
- Codex、OpenCode、Reasonix 的 agent side-channel 与 terminal business payload、mirror truth、control plane 物理隔离。
- Windows 只在真实 ConPTY gate 通过后标记支持；未通过前保持 beta/未完成状态。

## 范围与边界

In scope：

- 官方 Herdr 安装版作为外部 source。
- zterm daemon 与 Herdr 之间的显式 backend adapter。
- 单 terminal surface 的 observe/control 协议。
- ANSI/VT 状态重放、canonical cell projection、mirror revision、resize、reconnect、生命周期。

Out of scope：

- Herdr pane split、tab、workspace layout、焦点 UI。
- fork 或修改 Herdr 官方版本。
- 把 Herdr workspace/container 状态写入 zterm daemon client/session truth。
- 在 payload metadata 中混入 provider、routing、debug、retry、control 语义。

## 设计原则

- tmux 与 Herdr 都接入同一 daemon backend owner；不复制 mirror 语义。
- Herdr stream sequence 只作为 transport attachment metadata；zterm adapter 独立分配 canonical revision。
- `full=false` 只允许在同一 stream 的 parser baseline 存在且连续时消费；缺帧、乱序、重复、跨 reconnect/resize 复用 baseline 必须显式拒绝。
- 控制线、terminal input/output payload、agent side-channel 分离；失败不得 fallback 成功。
- 先完成 resource/module/function/mainline/verification map，再修改正式 runtime。

## 技术方案与文件清单

实验阶段：

- `playground/herdr-adapter-experiment-20260812/terminal-session-protocol-run.ts`
- `playground/herdr-adapter-experiment-20260812/ansi-canonicalizer.ts`
- `playground/herdr-adapter-experiment-20260812/ansi-canonicalizer.test.ts`
- `playground/herdr-adapter-experiment-20260812/*-evidence.json`

正式阶段候选路径，须经 architecture map 确认后才能落地：

- Herdr backend selection/adapter owner。
- Herdr observe/control transport owner。
- ANSI/VT canonicalizer 唯一 owner。
- daemon mirror writer 的统一 canonical commit edge。
- adapter-specific tests、feature registry、resource registry、mainline call map、verification map。

## 风险与规避

- ANSI frame 不是 canonical snapshot：使用 stateful VT parser；禁止忽略控制序列。
- Herdr seq 会在 resize/reconnect 重置：由 zterm 另发 revision。
- absolute scrollback/range/cursor 可能无法从 observe ANSI stream 完整恢复：先做能力判定；缺能力显式记录 gap，不伪造字段。
- Herdr agent integrations 不等于 zterm lifecycle truth：只通过 typed side-channel 投影。
- Windows ConPTY 行为与 macOS/Linux 不同：单独真实运行 gate，不以源码或交叉编译替代。

## 测试计划

- Playground：真实 Herdr frame full/delta replay；输入、resize、release、reconnect；正反 sequence/stream boundary。
- Canonicalizer：VT cursor movement、erase、scroll、SGR、Unicode width、CJK/emoji、wrap、alternate screen、OSC/kitty graphics 边界。
- Parity：同一命令/输入样本分别跑 tmux 与 Herdr，对比 canonical rows/cells/cursor/geometry/revision 行为。
- Daemon L2：zterm daemon mirror close-loop，确认 daemon mirror 只来自 canonicalizer commit。
- Agent：Codex/OpenCode/Reasonix side-channel 独立验证，确认控制语义不进入业务 payload。
- Windows：官方 Herdr + ConPTY 真实 gate；未通过不得宣称 Windows 支持。

## 实施步骤

1. 补齐 resource registry、module registry、function map、mainline call map、verification map。
2. 用真实 Herdr frame bytes 完成可靠 VT parser/canonicalizer playground，建立 tmux oracle 对比。
3. 完成 full/delta、gap、duplicate、reorder、resize、reconnect 正反 gate。
4. 设计并实现唯一 Herdr adapter，接入统一 daemon backend owner。
5. 完成定向测试、构建、安装/重启、daemon close-loop 与真实 Herdr 样本验证。
6. 完成 Codex/OpenCode/Reasonix side-channel 审计与 Windows ConPTY gate。
7. 二次评估：确认 parity、能力增量、剩余 gap；只有全部 required gate 通过后才标记可交付。

## 完成定义（DoD）

- 正式 adapter 已通过架构边界审查，且只有一个 mirror canonicalizer owner。
- tmux parity gate 与 Herdr backend gate 均有真实证据。
- agent side-channel 不污染 terminal payload/control plane。
- 安装运行版本与源码一致，daemon 重启后真实 Herdr session 可重放。
- Windows 状态明确为 pass 或 beta/gap，不使用模糊“支持”。
- 完成二次评估并将确证结论写入 `android/MEMORY.md`。
