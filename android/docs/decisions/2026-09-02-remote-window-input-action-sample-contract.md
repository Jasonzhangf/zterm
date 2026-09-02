# Remote-window input: Action 与 Timed Sample 合约

状态：design（本文件先锁定设计；实现、registry active 化和 gate 接线随后进行）

日期：2026-09-02

## 目标

远程串流输入必须把“已经识别出的行为”与“需要接收方修正的原始采样”分开。手势不能形成缓存或追赶队列；旧样本晚到时直接丢弃。手势频率、视频帧率、terminal buffer 发布频率和 UI render 频率互不约束。

## 方案对比与结论

### 参考做法

1. W3C Pointer Events / MDN `getCoalescedEvents()`：浏览器可将高频 pointer 更新合并为一次 `pointermove`；应用只有在需要精细轨迹时才读取 coalesced samples。该机制支持“采样高频、消费抽样”，但它不是网络缓存。
   - https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents
   - https://www.w3.org/TR/pointerevents4/#coalesced-events
2. WebRTC DataChannel：`ordered`、`reliable`、`maxRetransmits` 是独立属性。实时位置类数据通常不应等待可靠重传；需要完整生命周期的控制动作才使用有序、有限时限的可靠发送。
   - https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
   - https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/maxRetransmits
3. 实时交互系统的共同原则：离散控制事实保证顺序与生命周期；连续位置更新允许丢弃过期中间值；接收端以时间戳和当前状态修正，而不是回放过时轨迹。

### 与当前方案对比

| 方案 | 优点 | 问题 | 结论 |
| --- | --- | --- | --- |
| 所有 pointer move 进入同一个 reliable 队列 | 简单、容易保证顺序 | 延迟累积、旧位置追赶、拖拽失真 | 禁止 |
| 所有连续输入进入 timer + latest-wins pending | 能限制带宽 | 仍会暂存样本，造成额外等待；行为和采样语义混在一起 | 只可用于非手势业务，不用于 gesture sample |
| 所有手势都直接发 Action | payload 简单 | 接收方无法按采样时间修正复杂拖拽/移动 | 不足 |
| Action 与 Timed Sample 分离 | 离散行为可验证；连续手势可按时间修正并丢弃过期样本 | 需要两套 typed contract 和接收路径 | 采用 |

## 两类业务输入

### 1. Timed Gesture Action

用于已经完成识别、接收方应直接执行的非滚动行为，以及复杂手势的生命周期事实：tap、click、长按确认、drag start/end/cancel、pinch start/end 等。

```ts
type RemoteWindowTimedGestureAction = {
  kind: 'gesture-action';
  gestureId: string;
  sequence: number;
  phase: 'start' | 'update' | 'end' | 'cancel';
  sampledAtMs: number;
  deadlineMs: number;
  action: 'tap' | 'click' | 'drag' | 'pinch';
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  buttons?: number;
};
```

规则：

- `sampledAtMs` 是客户端单调时钟上的采样时间；`deadlineMs` 是业务有效期。
- 接收方先校验 gestureId、sequence、时间窗，再执行行为。
- 超时直接丢弃；禁止因为“可靠”而重放过时动作。
- 不建立无限队列；允许的可靠发送只能是有界、带 deadline 的生命周期发送。
- `start/end/cancel` 是生命周期事实，不能被普通中间 update 阻塞。

### 2. Continuous Scroll Action

滚动一旦被状态机识别为 scroll，使用独立的连续动作协议：

```ts
type RemoteWindowContinuousScrollAction = {
  kind: 'scroll-action';
  gestureId: string;
  sequence: number;
  phase: 'start' | 'update' | 'end';
  sampledAtMs: number;
  deltaX: number;
  deltaY: number;
  x?: number;
  y?: number;
};
```

规则：

- 样本产生后立即尝试发送；不进入 pending cache、flush queue 或历史重放队列。
- `start` 与 `end` 用于建立和关闭接收端状态；中间 update 可按需使用。
- 接收端至少消费新鲜的开头和结尾；中间 update 可合并、抽样或直接丢弃。
- 按 `sampledAtMs` 判断过期，不按网络到达时间伪造运动时间。
- 过期 update 直接丢弃；不追赶、不补发、不拼接旧轨迹。

## 原始采样与行为的边界

原始采样是输入事实，行为是识别结果：

```text
pointer / touch sample
  -> gesture classifier
     -> Timed Gesture Action
     -> Continuous Scroll Action
```

原始采样不得进入 terminal buffer、视频帧或 control metadata。`sentAtMs`、ACK、retry、health 和 queue 状态属于控制面；`sampledAtMs` 属于手势业务事件语义。

### 采样策略

- 浏览器/系统负责产生高频 `pointermove`；客户端可读取 `getCoalescedEvents()`，但不得把所有 coalesced events 写入网络 payload。
- 本地状态机只保留识别所需的起点、最新位置、累计必要 delta 和采样时间。
- 拖拽/移动的中间路径不是 canonical truth；接收方使用有效样本自行修正位置、速度和时间间隔。
- `pointer down`、`pointer up`、`pointer cancel` 必须分别表达生命周期事实；不能用旧 move 队列补偿它们。

## 时间与丢弃规则

```text
sampledAtMs  = 手指产生样本的单调时间
sentAtMs     = 网络发送时间（control side-channel）
receivedAtMs = daemon 接收时间（接收观测）
```

接收方维护每个 `gestureId` 的最后接受时间和 sequence：

- sequence 倒退或重复：丢弃并记录 typed duplicate/stale fact。
- `now - sampledAtMs > deadline`：丢弃，不执行。
- update 比当前已接受样本更旧：丢弃。
- 中间样本缺失：允许继续使用最新有效样本，不视为协议错误。
- end/cancel 过期：显式结束失败并暴露错误，不回放旧轨迹。

## 与其他频率的隔离

以下 cadence 不共享：

- 手指采样 cadence：系统/pointer event。
- 手势 Action / Sample 发送 cadence：输入 delivery。
- 图片采集与 WebRTC video cadence：视频 profile。
- terminal mirror / text buffer publish cadence：daemon buffer publisher。
- UI render cadence：客户端渲染器。

任何一个链路变慢，都不得通过修改另一条链路的 timer、queue 或 profile 来补偿。

## Owner 与禁止路径

- `client.remote_window_touch_action`：识别并产生 Action/Sample，不拥有网络队列。
- `client.remote_window_input_delivery`：区分 timed reliable action 与 immediate sample admission；不得把 sample 放入历史缓存。
- `daemon.remote_window_input_policy`：校验时间码、sequence、deadline 和手势生命周期。
- `daemon.remote_window_input_apply`：按需合成有效 sample 并调用 OS input owner。
- `daemon.buffer_publisher`：只负责 terminal buffer；禁止连接 remote-window gesture。
- `remote_window_stream` video sender：只负责图片帧；禁止消费手势采样。

禁止：统一 gesture/buffer flush timer、gesture sample retry replay、完整路径保存、以 `sentAtMs` 代替 `sampledAtMs`、把控制面状态写进业务 payload。

## 验收标准

1. 高频 pointer samples 可被 coalesce，但不形成客户端历史缓存。
2. 普通已识别手势只发送一个 typed Action，过期 Action 不执行。
3. drag/move 生命周期使用带时间码的有效样本；过期中间样本直接丢弃。
4. scroll 发送 start/update/end；中间 update 可按需抽样，不能阻塞 end。
5. 接收端不会因旧样本重放而回跳、追赶或产生延迟轨迹。
6. 手势、视频、terminal buffer 和 UI render 的 cadence 有独立测试证明。
7. 正反测试覆盖：新鲜/过期、顺序/重复、start/end/cancel、丢中间 update、无缓存/无重放。

## 实施顺序

1. 本设计文档与公开参考证据落盘。
2. 更新 resource registry、function map、mainline call map、verification map，声明唯一 owner、边界和 gates。
3. 接入机器 gate，先让 registry 与真实 import/call edge 对齐。
4. 先补红测，再改 shared typed contract、client delivery、daemon policy/apply。
5. 运行定向测试、全局 gate、构建、emulator/真实用户入口；验证完成后才能 review、commit、merge 或发布。

## 当前落地状态（2026-09-02）

本轮已落地第一 slice：wire payload 增加 `deliveryKind`、`sampledAtMs`、`deadlineMs`；客户端为 Action 自动设置有界 deadline，sample/scroll 立即发送；客户端和 daemon 均移除 continuous 的 pending/cache/flush 合并路径。daemon 对显式 sample/action 做边界校验，并在 Action 进入执行队列前检查 deadline。

仍未宣称完整协议闭环：当前旧事件形状尚未全部升级为独立的 `gesture-action` / `scroll-action start/update/end` union，daemon 也尚未持有每个 gesture 的 sequence/lifecycle 接收状态；这些属于下一 slice，不能用本轮字段标记替代。
