# 收端丢包观察设计（receiver receive-loss observation）

状态：D0 设计候选。基线 `c5f2860a`。本文件只定义**一个**最小收端丢包观察对象流与唯一 owner，供独立 design review 在编码前准入。图的静态校验不证明 operator 注册、编译或真实功能接线（`dagpipe` CLI 只校验拓扑）。

只读依赖（不修改）：`remote-window-quality.graph.json`（既有三节点请求→应用→结算质量图）与
`2026-10-02-stream-control-design.md`（已准入控制设计，含 R4/R5）。质量请求对象流与本观察对象流
是两个 SESE 图：本图只做“观察”，质量意图经既有 `client.remote_window_quality_control.admit` 委托到
既有质量请求图；**不新增第二个 pending 或 ACK owner**（ACK 真相仍只来自既有 controller 的
matching applied 结算）。

产品源码只读核实的精确位置见文末「验证」与下方 owner 表；本设计不宣称已实现、已接线或已通过真机。

## 目标与单一机制

目标是让真实链路丢包能进入既有的网络降码率分支。诊断报告（`abr-network-signal-diagnostic/report.md`，
CONFIRMED）已确认首个偏差：收端 `remote-window-receiver-runtime.ts:827-829` 从 `inbound-rtp` 读
sender-only 的 `qualityLimitationReason`；纯策略只认 `limitation === 'bandwidth'`，因此真实丢包恒进不了
network 分支，被误归入 latency（保留 focus 满预算 `maxBps 8e6`）。

**单一机制**：唯一收端 stats producer（`getStatsSample`）复用既有“每 lane 独立 interval baseline +
身份（mediaEpoch/trackId + inbound SSRC/MID + transportId）”语义，产出可空类型化丢包信号
`receivedPacketLossRatio`；该信号被既有纯策略 `classifyRemoteWindowVideoPressure` 消费为 network 分支，
并经既有 `resolveRemoteWindowVideoAdaptiveDecision` 与观察窗口/恢复窗口整合。不新增独立采样 owner、
不重建身份真相、不从日志重建状态。

## 精确 owner 与类型

| 语义节点 | 图的 Operator（设计绑定，未注册） | 唯一 owner | 本设计内的精确改动 |
| --- | --- | --- | --- |
| 准入观察节拍 | `client.remote_window_quality_observation.admit@0.1` | `useRemoteWindowQuality.ts` 观察 effect（`streamReady`/`qualityStreamActive` + `stopped`/generation guard；**现状 `window.setInterval(() => void tick(), 2000)` 无重叠护栏**） | 在既有观察 effect 内加入最小 in-flight 准入护栏（见下「单飞生命周期」）；无新状态 owner、无新队列/定时器/重试/全局状态；沿用既有 genesis/unknown 早退顺序 |
| 按 lane 采样 | `client.remote_window_receiver.get_stats_sample@0.1` | `remote-window-receiver-runtime.ts` 的 `getStatsSample(streamId, lane='focus')` | 在既有 baseline 上增加落盘 `packetsReceived/packetsLost`，经既有 finite 边界产出 `receivedPacketLossRatio?: number|null`（缺失/非有限 → null）；删除 sender-only `qualityLimitationReason` 读取 |
| 类型化策略判定 | `client.remote_window_quality_control.classify_observation@0.1` | `remote-window-video-quality.ts` 的 `classifyRemoteWindowVideoPressure` + `resolveRemoteWindowVideoAdaptiveDecision` | classify 增加 network 丢包分支（可用丢包 >=5% 优先，且携带既有 severe-render 标志）并移除 limitation 派生分支；decision 恢复/unknown 门把 `identifiedInterval` 并入有限丢包可用性 |
| 唯一结算观察结果 | `client.remote_window_quality_control.settle_observation@0.1` | `useRemoteWindowQuality.ts` 的 `runAdaptiveQualityTick` / `observeUnknownAdaptiveSample`；质量意图仅经 `requestQualityRef`（`origin:'adaptive'`）委托既有 admit | 不改写 ACK；只投影未知/不变/质量意图/错误/取消 |

**类型声明（按精确定义）**：`RemoteWindowVideoStatsSample` 的唯一定义在
`android/src/lib/remote-window-video-quality.ts:120-137`（client-local，不在 `@zterm/shared/protocol`
wire union 中，也未经由 `src/lib/types.ts` 再导出；生产 import 路径是 `./remote-window-video-quality`）。
本设计在该定义上：
- 新增 `receivedPacketLossRatio?: number | null`（nullable optional，旧 fixture 缺该字段不破坏无关 consumer，符合 R4 兼容语义）；
- 删除 `qualityLimitationReason?: string | null`（唯一 writer 将被删除，无真实取值来源；sender-only 字段不进收端样本）。
`RemoteWindowVideoPressureCause` 联合类型保持不变（`none|network|host|render|latency`）；删除
`limitation` 派生的 `network`/`host` 分支后不再有产生 `host` 的入口，该成员保留为类型稳定选择（不伪造 host 健康，
不为删除联合成员扩大无关 churn；`host` 分支对当前契约无消费者）。

## 单飞生命周期（既有观察 effect 内的最小准入护栏）

现状 owner 不保证单飞：`useRemoteWindowQuality.ts` 观察 effect 用 `window.setInterval(() => void tick(), 2000)`
启动串行节拍，但 `tick` 内 `await collectStats()` 无 overlap 护栏；当 `getStats` 慢于 2000ms 时两次采样会重叠。
重叠不是本设计引入，且不改变既有 `sameStatsIdentity`/`elapsedMs` 语义下各自正确地算出区间；但重叠会让同一 effect
在任一时刻持有多个未结算采样，使“至多一个未结算采样”的准入前提不成立。因此本设计要求在**既有观察 effect owner**
内加入最小 in-flight 准入护栏（不新增采样 owner、队列、定时器、重试或全局状态）：

- `effect` 内维护一个局部 `inFlight: boolean`（每次 effect 建立都为 `false`，随 effect 作用域销毁）。
- `tick` 入口：若 `inFlight` 为真，或 `stopped`/`requestGenerationRef.current !== effect 代次`（沿用现有 `stopped`
  与 generation guard），直接返回，不采样、不结算。
- 仅当通过上述门时才置 `inFlight = true` 并获得该次采样准入；`collectStats()` 为 `null`、`await` 拒绝/抛错、
  或本轮正常 settle，统一在 `finally` 释放**本次自己的**准入（`inFlight = false`），成功/reject/cancel 都不漏放。
- teardown（cleanup 置 `stopped = true`）后，迟到的 `collectStats` closure 结果只释放自己的准入并丢弃，不再
  settle、不清任何其他 effect 代次/其他 stream 的护栏；新 effect 代次拥有自己的 `inFlight`，旧 closure 不得清除它。
- 语义不变量：任一 effect 作用域内，未结算采样数 `<= 1`；重叠被消除而非被排队；无 `setTimeout`/重试补偿。

有界生命周期（在既有状态机内）：`空闲` -(节拍通过 stopped/generation/in-flight 门)-> `采样中(inFlight=true)`
->(`首次结算，finally inFlight=false`)-> `空闲`；`采样中` -(cleanup/`stopped`/generation 变化)-> `取消`
（迟到结果丢弃、只释放自己的准入）；`采样中` -(reject/throw)-> `错误`（finally 释放，按既有 unknown 结算）。
终态与单出口仍归 `settle_observation`。公开 delayed-collect/rejection/teardown 用例属**开发辅助**证据（见下），
不替代真机验收，也**不宣称该护栏在产品现状已存在**。

## 丢包信号语义（producer）

`receivedPacketLossRatio = lostDelta / (receivedDelta + lostDelta)`，其中：
- `receivedDelta = packetsReceived(cur) - packetsReceived(prev)`；
- `lostDelta = packetsLost(cur) - packetsLost(prev)`；
- `totalDelta = receivedDelta + lostDelta`。

**可用判定**：仅当 `sameStatsIdentity(prev, cur)` 成立、`elapsedMs > 0`、`totalDelta > 0`、
`lostDelta >= 0`、`receivedDelta >= 0`。任一不满足则 `receivedPacketLossRatio = null`（unknown），
**不 clamp 成 0、不伪装 healthy**。

**有限数边界（producer 写、consumer 读）**：`packetsReceived`/`packetsLost` 是可选 wire 字段，必须经既有
`finiteNumber(value)` 边界读取（`typeof value === 'number' && Number.isFinite(value)`，见
`remote-window-video-quality.ts:415-417`）才参与增量；缺失、`undefined`、`null`、`NaN`、`Infinity`
一律解析为 `null`，**不 clamps 成 0、不当 0 丢包处理**。producer 仍校验有限计数器、同一身份、`elapsedMs > 0`
与两个非负 delta；`lostDelta < 0`（签名修正）或 `receivedDelta < 0` 不做 clamp，直接判 unknown。

**进入 unknown（null）的情况**：
- 首样本（无 baseline）；
- 计数字段缺失/`undefined`/`null`/非有限数（经 `finiteNumber` 边界后为 `null`）；
- 身份未知或替换（mediaEpoch/trackId/SSRC/MID/transport 变化，沿用现有 `sameStatsIdentity` 语义）；
- baseline 丢失（`prev` 计数缺失/无效，即“baseline loss”）；
- 计数回退，包括被签名的丢包修正（`lostDelta < 0` 或 `receivedDelta < 0`）；
- 零流量/无新包（`totalDelta === 0`）；
- `elapsedMs <= 0`。

consumer 侧（policy）**不得**对可选字段写 `receivedPacketLossRatio !== null` 这种裸判——`undefined !== null`
为真会把缺计数的样本误判为可用。统一写成显式有限谓词（与 producer 边界同语义）：

```ts
// finiteNumber 复用既有定义；undefined/null/NaN/Infinity 全部归一为 null(unknown)。
const lossRatio = finiteNumber(sample.receivedPacketLossRatio); // number | null
const usableLoss = lossRatio !== null && lossRatio >= 0.05;     // 才进入 network
```

- 缺计数/非有限 → `lossRatio === null` → **unknown**，既不进 network，也不计入 healthy/恢复，也不消耗 fresh 采样槽；
- 即便 producer 因早退路径（`remote-window-receiver-runtime.ts:815`/`819` 附近）返回未携带该字段的样本，
  上面谓词也归 unknown，绝不把 `undefined` 当健康或当 0% 丢包消费。

unknown 的丢包观察**不累计 network 压力**，也不用于健康/恢复：它不能消耗两个 fresh 有效采样槽、
不能清已应用档位/压力原因。按 R5 语义，unknown 节拍通过 policy unknown 分支**精确一次**清观察窗口
（`consecutivePressureSamples`/`stableSinceMs`/`lastSample`），保留已应用 `level`/`pressureCause`。

## 阈值与优先级

- **丢包阈：持续 5% 丢包（起始值）**。单次 interval `receivedPacketLossRatio >= 0.05` 计为一次丢包压力样本，
  沿用既有 consecutive-pressure 规则：`consecutivePressureSamples >= pressureSamplesBeforeDowngrade（默认 2）`
  且 `intervalReady`（距上次调整 >= `minimumAdjustmentIntervalMs`，默认 4000ms）才降档。即 2000ms 节拍下约
  **4 秒持续 >=5% 丢包**触发一次 network 降档。取值依据：能力证据实测约 **8.2% interval 丢包**
  （`packetsLost 0→37 / received 98→510`，合计 449 包，`37/449 ≈ 0.082`，400ms/20% 名义丢包的真实被观测值）；
  5% 距正常 WebRTC 抖动脉冲噪声（通常 <1–2%）与实测劣化级（约 8%）都有分隔余量，且不低到把瞬时 burst 当持续拥塞。
- **不做独立 severe（立即降档）丢包阈**：当前证据只有单一劣化族（约 5–8% 区间），不足以区分需立即降档的
  “severe” 丢包群体；再设一个常量是投机 knob。因此丢包本身不携带**独立的** severe 判定——即不新增
  “仅凭丢包率立即降档”的阈值。丢包分支只决定 cause=`network`；其 `severe` 位**转发同一 sample 上既有
  genuine severe-render 谓词的结果**（见下），不引入第二个 severe 来源。

**既有 severe-render 谓词（policy，原样保留，不改阈值）**：`classifyRemoteWindowVideoPressure`
在 render 分支（`remote-window-video-quality.ts:457-465`）满足
`(droppedDelta >= 3) || (freezeDelta > 0)` 时返回 `cause: 'render'`，并置
`severe = (droppedDelta !== null && droppedDelta >= 20) || (freezeDelta !== null && freezeDelta >= 2)`。
`resolveRemoteWindowVideoAdaptiveDecision:570` 的 `shouldDowngrade = intervalReady && (pressure.severe || consecutive >= required)`
即“立即降档”机制。本设计不引入任何新的 loss-only severe 阈值。

- **network 优先级（唯一确定性结果）**：当且仅当**可用丢包**（`finiteNumber(receivedPacketLossRatio) !== null`）
  满足 `>= 0.05` 时，`classify` 返回 `{ cause: 'network' }`，其 `severe` 位**原样携带同一 sample 上的既有
  genuine severe-render 判定**：
  `severe = (droppedDelta !== null && droppedDelta >= 20) || (freezeDelta !== null && freezeDelta >= 2)`
  （即“该 sample 同时满足 loss>=5% 与既有 severe-render 谓词”时，network 结果 `severe:true`，从而沿用既有
  立即降档机制；不新增 loss-only severe 阈值）。普通丢包（未达 severe-render）`severe:false`，走持续规则。
  理由：真实丢包链路上 frame drop 与 jitter/RTT 都是下游症状；诊断报告已证实丢包被 latency 分支吞掉并保留
  focus 满预算。这是单一、可判定的规则：**同一 sample 同时 >=5% 丢包与 severe render 时，结果唯一为
  `{ cause:'network', severe:true }`**——不再存在“先返回 network/severe:false、又另行返回 render 立即降档”的矛盾。
- **无可用丢包压力时**（丢包缺席 = unknown，或可用且 `< 0.05`）：保持既有 render → latency → none 顺序，
  即既有 render（含 severe）、latency（rtt/jitter）分类与健康/恢复语义不变。

**优先级覆盖表（同一 sample 的唯一结果）**：

| 场景 | 输入判定 | classify 唯一结果 | decision 结果 |
| --- | --- | --- | --- |
| 普通丢包 | 可用 loss>=5%，无 render 压力 | `{cause:'network', severe:false}` | 持续 2 样本且 `intervalReady` → downgrade（network 档） |
| 丢包 + severe render | 可用 loss>=5%，且 severe-render 谓词为真 | `{cause:'network', severe:true}` | `severe` 为真 → 立即 downgrade（既有机制，档位仍受 min(userCap,lastACK) 约束） |
| 仅 severe render | 无可 `.05` 丢包压力，render 谓词为真且 severe | `{cause:'render', severe:true}` | 立即 downgrade（既有 render 立即降档） |
| 仅 latency | 无丢包压力、无 render 压力、rtt>=350 或 jitter>=250 | `{cause:'latency', severe:false}` | 走既有 latency 持续规则 |
| unknown | 丢包缺失/非有限，或无可用区间 | policy unknown（不返回 cause） | 清观察窗口，保留已应用 level/cause，不派发、不消耗 fresh 槽 |

用户 caps（`userMaxBitrateBps`）、matching applied ACK、`minimumAdjustmentIntervalMs（4000ms）` 与
`restoreStableMs（12000ms）` 恢复窗口在本修复中保持不变。
- **恢复（最小有意义规则）**：恢复仍要求既有“已建立 interval 且可信健康样本持续经稳定窗口”。本设计把
  “可用丢包区间”纳入已建立 interval 门（见下），因此**零流量/不可用丢包区间不能累计恢复**；丢包本身不能证明健康，
  只有 `receivedPacketLossRatio` 可用（非 null，且 <5%）且 `receivedBitrateBps` 已建立、且无 render/latency 压力，
  才从首可信健康样本起计 `restoreStableMs（默认 12000ms，12 秒，沿用 R5）`，稳定期满逐步向 `userMaxBitrateBps`
  （<= userCap）恢复，每档一次；matching applied ACK 才改变 applied。无可信 stats 不能因缺样本自动恢复。

## 既建立 interval 门并入丢包可用性

`resolveRemoteWindowVideoAdaptiveDecision` 现有“无压力信号 → 健康/恢复须已建立 interval”
（`receivedBitrateBps === null` 走 unknown）扩展为：

```ts
// 两个可选 gauge 都必须先过既有 finiteNumber 边界；不得对可选值写 !== null。
const identifiedInterval =
  finiteNumber(sample.receivedBitrateBps) !== null
  && finiteNumber(sample.receivedPacketLossRatio) !== null;
```

- `finiteNumber(receivedPacketLossRatio) !== null` 即该节拍观察到真实包流（`totalDelta > 0`、无计数回退、同身份、
  计数字段有限）；`receivedBitrateBps` 复用既有 `finiteNumber` 处理（`:592`）。
- 零流量/回退/身份替换 → `receivedPacketLossRatio === null` → `identifiedInterval` 假 → 走 unknown
  （清观察窗口，不能累计恢复）。这精确实现“zero traffic→unknown；unknown 不能累计 healthy recovery”。
- 正常健康流（无丢包）`lostDelta=0` → `receivedPacketLossRatio = 0`（非 null）→ 可计入恢复。低流量但持续发包
  （focus 2s 内必有包）仍为非 null。

该门与 R5 unknown 语义一致（first-interval/fps-only/身份变化→清窗口），只新增“零流量包流也判 unknown”，
最小、单一 owner，不新增第二个 unknown 机制。

## 单一对象流（SESE）与状态机

图：`android/docs/dagpipe/remote-window-quality-observation.graph.json`（新增）。单入口
`arc.observation_tick` → `admit_observation` → `sample_lane_stats` → `decide_loss_policy` →
`settle_observation` → 单出口 `arc.observation_result`。边即依赖/事实，非函数调用图；本图不成环、不回跳、
不隐式跨图回边。质量意图只在 `settle_observation` 处委托既有 `admit`（`depends_on` 声明，只读依赖，非图 root）。

状态机（caller-owned，跨 execution 循环；静态 DAG 无回边）：

```text
[*] -> 待节拍: 观察已启用(streamReady/qualityStreamActive)
待节拍 -> 采样与身份区间: 触发 2000ms 节拍，通过 in-flight/generation guard 后取得采样准入
待节拍 -> 待节拍: 节拍到达但已有未结算采样(in-flight)或已 stopped/代次变化，丢弃本拍
采样与身份区间 -> 类型化策略判定: 得到可用样本
采样与身份区间 -> 唯一结算: 样本不可用(null/身份替换/collectStats 拒绝)，finally 释放本次准入
类型化策略判定 -> 唯一结算: 产出 unknown/不变/降档/恢复 决策
唯一结算 -> 待节拍: unknown/不变(hold/baseline) 落窗，finally 释放准入，等待下一节拍
唯一结算 -> 既有质量 admit: 质量意图(downgrade/restore)只经既有 admit 委托
唯一结算 -> 待节拍: 委托后既有 ACK/NACK 单独结算，本图不建第二 pending/ACK
待节拍 -> [*]: 取消/teardown/generation 变化/流身份改变，丢弃在飞 closure（只释放自己的准入）
```

**出口与终态**（`arc.observation_result`，唯一结果消费者为观察者/测试）：
- `unknown`：不可用丢包区间；保留已应用档位与 cause，清观察窗口，不派发、不消耗两个 fresh 采样槽。
- `no-change`（hold/baseline）：无降档/恢复动作；已应用档位不变。
- `quality-intent`：typed 降档/恢复候选，随同一次 request closure 保存；**只有 matching applied ACK
  才提交候选档位**，rejected/throw/timeout/迟到/陈旧 generation 一律 discard，保留 lastACK。
- `error`：`collectStats` 抛错/拒绝、身份 unconfirmable 或决策异常；明确错误结果，保留已应用档位，清窗。
- `cancel`：teardown/generation 变化/identity 变化/停止；清观察与 skip，丢弃所有旧 closure 结果。

对象流各终端：
- 成功终点：`observation_result` 已产生（unknown/no-change/quality-intent 之一）；quality-intent 的真实接线
  由既有 admit→apply→settle 返回 matching ACK/NACK，applied 只来自 controller ACK。
- 失败/错误终点：`error` 结果（保留 original 错误显式暴露），不伪造 healthy、不派发质量请求。
- 上游（委托）失败终点：进入既有 admit 得到 `rejected.unsupported` 等 typed 拒绝——本图显式投影该拒绝，
  停止本 stream 自动派发（沿既有 unsupported 守卫），不改写 ACK，不重试。
- 取消终点：见 `cancel`。
- 清理终点：清理本任务自有资源（stop/dispose 删除该 lane baseline、in-flight closure 丢弃、进程；
  无自有质量 in-flight pending 记录）。**对真实运行环境的 native teardown / per-env 清理归属 native author，
  不在本图、不是另一个图 root**；既有 native 139 是独立 blocker，不因本设计宣称自然退出。

## 实现 allowlist（供编码前派单；未准入不实现）

允许 writer（最小集）：
- `android/src/lib/remote-window-receiver-runtime.ts`：baseline 增记 `packetsReceived/packetsLost`，产出
  `receivedPacketLossRatio`（复用 `sameStatsIdentity`/`elapsedMs`；不 clamp 负增量）；删除 sender-only
  `qualityLimitationReason` 写入。
- `android/src/lib/remote-window-video-quality.ts`：`RemoteWindowVideoStatsSample` 加
  `receivedPacketLossRatio?: number|null`、删 `qualityLimitationReason`；`classifyRemoteWindowVideoPressure`
  加丢包 network 分支（优先级最高）、移除 limitation 派生分支；`resolveRemoteWindowVideoAdaptiveDecision`
  的 healthy/unknown 门并入“可用丢包区间”。
- `android/src/components/terminal/useRemoteWindowQuality.ts`：仅观察/admit 边界内部消费该信号与
  `identifiedInterval`；无新增状态 owner。
- 对应测试：`remote-window-video-quality.test.ts`、`useRemoteWindowQuality.test.tsx`、receiver runtime 配套
  paired tests（纯函数/官方 fixtures，不 mock 私有 baseline/identity）。
- 既有 ABR/public consumer：`android/scripts/remote-window-quality-stats-probe.ts`（R4 冻结的 stats contract
  probe）更新为消费真实 loss 信号、删除注入的 `qualityLimitationReason:'bandwidth'` 夹具。

**fixture 迁移 allowlist（删 `qualityLimitationReason` 的必需消费者）**：删除
`RemoteWindowVideoStatsSample.qualityLimitationReason` 后，所有仍构造该字段的 test/probe fixture 会因 excess
property 被 `tsc`/build 阻断，实现 DAG 会断在测试边。最小迁移清单（把 fixture 从 sender-only limitation
改为收端 loss 信号，并保留有意义的行为断言，不做投机 UI 改动）：

| 文件 | 现状位置 | 最小迁移 |
| --- | --- | --- |
| `android/src/lib/remote-window-video-quality.test.ts` | `:307,:313`（cpu）, `:341,:412,:418,:431,:438,:451,:457,:542`（bandwidth） | pressure fixture 改为可用丢包样本（`receivedPacketLossRatio` 达阈值，配 `receivedBitrateBps`/身份），断言仍为对应 cause/downgrade/restore；host-from-limitation 用例删除或改为显式无丢包→none/hold |
| `android/src/components/terminal/useRemoteWindowQuality.test.tsx` | `:242,:252`（stats-observable fixture）, `:409`（`pressure()` helper） | `pressure()` 改为丢包驱动的 network 样本；`lastStatsSample` 断言改查 `receivedPacketLossRatio`，不再查 limitation |
| `android/src/components/terminal/RemoteWindowOverlay.test.tsx` | `:1810`（`collectStats` mock 内的 `qualityLimitationReason:'bandwidth'`） | **依赖边，见下**；本轮不得由 ABR 实现并发改写 |
| `android/scripts/remote-window-quality-stats-probe.ts` | `:316`（sample 投影）, `:571`（`buildPressuringSample`）, `:653,:659`（policy 用例内联 fixture） | policy 用例 fixture 与 `buildPressuringSample` 改为收端 loss 样本，raw 投影加 `receivedPacketLossRatio`，删注入的 limitation |

**frontend 所有者依赖边（必须显式保留）**：`RemoteWindowOverlay.test.tsx` 当前由 live FRONTEND author 拥有。
删除 sender-only `qualityLimitationReason` 会波及该文件 `:1810`，但 ABR 实现**不得**并发改写前端行为测试。
因此：
- 该文件的 fixture 迁移是 **ABR 实现的完成前置条件之一**，但只有 Root 收到 frontend 的 natural final 后，
  才能冻结并下发该文件精确的测试输入；在此之前 ABR 实现停在“除 `RemoteWindowOverlay.test.tsx` 外的
  fixture 迁移完成”，并以 full typecheck 暴露该残留断边，不得用局部 typecheck 或跳过绕过。
- 该依赖是跨任务资源边（ABR observation 实现 ⇐ frontend final + 冻结输入）；未满足时该实现节点为 `blocked`，
  不计完成。禁止 revert 前端行为测试、禁止并发写、禁止 `--no-verify`/局部跳过门禁。

禁止（只读，他人 owner）：shared transport/server/native/UI/版本文件；`remote-window-quality.graph.json` 及既有
start/quality/input/stop 图；不新增第二政策/第二 ACK/pending owner；不新增治理框架/配置 knob；不在本任务提交
或发布任何 APK/OTA。**唯一例外**是上表 frontend 所有者依赖边中 `RemoteWindowOverlay.test.tsx`
的 `:1810` fixture：仅当 Root 收到 frontend natural final 并下发精确冻结测试输入后，ABR 实现才可迁移该一处；
在此之前该文件对 ABR 实现为只读，产品/UI 无关文件始终禁止。

## 证据与边界

复用已 CONFIRMED 证据（不再重跑）：
1. `../abr-network-signal-diagnostic/report.md`：收端读 sender-only `qualityLimitationReason`；policy 只认
   `bandwidth`，真实丢包进不了 network 分支（CONFIRMED）。
2. `../abr-packet-counter-capability/abr-live-consumer-pressure-recovery-1791185332470-55289.json`（+`live.log`/`live.exit=139`）：
   同一 video inbound id/SSRC/mid/transport，92 次直接公开 `peer.getStats` 观测，`packetsLost 0→37`、
   `received 98→510`（interval 丢包约 `37/449 ≈ 8.2%`）；实际 relay 49 包丢弃；400ms/20% 丢包；压力 ACK rev3 只改
   age/overview、保持 8Mbps/30FPS；恢复超时；native 自然退出 139。**该能力证明包计数器存在，不证明 ABR 修复或自然退出。**

边界：阈值（5% 起始、持续 2 样本、12s 恢复）是起点设计值，独立 review 可裁量；本设计不制造第二阈值来源。
没有媒体扰动工具与已安装 nominee UDP relay 前，不给媒体优化验收 PASS（现状按 R4/R5 未宣称 ABR 功能生效）。

## 公开测试与真实验收

**开发辅助**（可先于真机）：公开 policy/receiver 纯函数 paired 用例 + 可控 sample fixture：
- 丢包进入 `cause:'network'`，且 latency/render 分支在丢包缺席时保持原状；
- 有限门：`receivedPacketLossRatio` 缺失/`undefined`/`null`/`NaN`/`Infinity` → `unknown`（非 healthy、非 0%），
  不累计压力/恢复；`identifiedInterval` 用 `finiteNumber` 两字段判定；
- `lostDelta<0`（signed 修正）、`receivedDelta<0`、`totalDelta===0`、身份替换、首样本 → `unknown`，不累计压力/恢复；
- 优先级：普通丢包→`{network,severe:false}`；同一样本 loss>=5% 且 severe-render→`{network,severe:true}` 立即降档；
  仅 severe-render→`{render,severe:true}`；仅 latency→`{latency,severe:false}`；无可丢包→unknown；四类结果互斥且确定；
- 5% 持续 2 样本降档一次；降档后 `next <= min(userCap, lastACK)`；未知不清位、不消耗两个 fresh 采样槽；
- 零流量节拍判 unknown、12s 稳定健康窗口恢复且 `<= userCap`；
- 重复 interval 丢包不被 double-delta 遮蔽；
- **单飞生命周期（观察 effect 公开用例）**：慢 `collectStats`（>2000ms）期间的第二次节拍被准入护栏丢弃，
  任一 effect 代次内未结算采样 `<=1`；`collectStats` reject/throw 在 `finally` 释放自己准入且按 unknown 结算；
  teardown 后迟到 closure 结果丢弃、不清另一代次护栏；成功路径 `finally` 释放后下一节拍可正常采样。

公开 runtime consumer（真实文件 `remote-window-quality-stats-probe.ts`，实际 `--case` 取值
`policy-pressure|policy-recovery|receiver-lanes|receiver-restart`，**每次调用只传一个 `--case` 值**，串行执行）：

```bash
NODE_OPTIONS=--expose-gc pnpm --dir android exec tsx scripts/remote-window-quality-stats-probe.ts \
  --case policy-pressure --output-dir <owned-evidence>
# 串行重复，--case 分别取 policy-recovery、receiver-lanes、receiver-restart（每命令一个值）
```

该 probe 真实 import 既有 policy 导出与真实 receiver runtime，使用真实 `RTCPeerConnection`/`RTCVideoSource`/
真实帧接收，不 mock `getStats`/baseline/private state；`receivedPacketLossRatio` 与公开 raw 累计值联证；
stop→新 stream start 第一 interval unknown；旧 peer/resources 终点可核对。自然 exit 0 仅当该 `--case` 断言 PASS。
unit/probe 只是**开发辅助**证据，不替代下方真机验收。

**必要真实验收**（作者编码并通过后由 parent 串行执行）：installed nominee UDP relay + 实际丢包 → 收端
`receivedPacketLossRatio` 真实 >5% → `origin:'adaptive'` 质量请求 → matching applied ACK（network 档位生效）→
原位解码连续帧 + 12s 健康恢复。禁止以注入 `qualityLimitationReason` 当 network 证明；禁止 forced GC/exit、
timeout 膨胀或 oracle 削弱。既有 native 139 保持独立 blocker，不并入本设计结论。

## 验证

- `dagpipe graph validate android/docs/dagpipe/remote-window-quality-observation.graph.json` → rc=0（actual）。
- `git diff --check` → rc=0（actual）。
两检查日志与 rc 记录于 `joint-delivery/abr-loss-design-r2-author/notes.md`、`report.md`（`dagpipe-validate.log`、
`diff-check.log`）。

## 不适用与未验证

- 本图为设计拓扑，非 Rust 注册执行图，不要求 SDK compile 或新增第二运行时框架。
- 不宣称任何真实设备/媒体/手势已通过；以上阈值、owner、恢复语义到实现后才可验证。
- 已建立 interval 门并入丢包可用性是本设计对 R5 语义的最小、单一 owner 扩展；独立 review 应复核其不破坏
  既有 healthy-recovery 与 latency/render 分类。
