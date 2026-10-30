# Android rtc-direct send flow truth

日期：2026-10-30
范围：Android 前台局域网 `rtc-direct` 的本端发送队列投影、拥塞分类、
文件下载 pacing 与 publisher 逐块 admission。

## 背景

Android JS socket 的 `bufferedAmount` 恒为零，原生短时发送失败会在约数百毫秒内
升级为物理重连；文件下载用 `setImmediate` 连续发送，不读取物理 transport 背压。
本决策只处理本端发送流控，不改变 traversal tier 优先级、remote-window 预算、
后台电源策略、daemon mirror truth 或 renderer 策略。

## 唯一 owner 与归属

- 原生 DataChannel 队列读数与 drain 通知：`AndroidRtcTransportBackend.java`
  （`client.connection_service`）。
- 发送 admission、待发 FIFO、generation fencing、重连分类：
  `AndroidConnectionService.java`。
- 不可变 flow snapshot 与 JS 投影：
  `AndroidConnectionServiceSnapshot.java` / `AndroidConnectionServiceEvent.java` /
  `AndroidConnectionStateMachine.java` / TS snapshot / socket。
- 下载发送节奏与取消清理：`terminal-file-transfer-list-runtime.ts`
  （`daemon.file_transfer`）。
- 物理背压读取：`terminal-transport-runtime.ts`（`daemon.transport_subscriber`）；
  下载模块只读 transport 的 `bufferedAmount` getter，水位常量唯一驻留在
  `terminal-runtime-types.ts`（`daemon.runtime`），避免 `file_transfer ->
  transport_subscriber` 环边。
- buffer-sync 分片预算与续发：`daemon-buffer-publisher-runtime.ts`。
- 上传异步发送顺序：`file-transfer-throughput-runtime.ts`。

## 发送队列投影

`transportFlow` 是 typed flow observation，字段：

```text
nativeBufferedBytes: number
serviceQueuedBytes: number
serviceQueuedFrames: number
backpressured: boolean
sampledAt: number
```

规则：

1. `nativeBufferedBytes` 只来自当前 native transport，读取前/成功后/回调、
   open/close 边界更新；关闭后不再访问已 dispose 的 DataChannel。
2. `serviceQueuedBytes` 只统计 service 拥有、尚未被 native 接受的帧；成功交给
   native 后必须从 service 队列移除，避免重复计数。
3. `null` 表示当前没有有效 flow observation，不得宣称为零。
4. flow observation 不更新 `lastActivityAt`、不清 heartbeat misses、不把连接改为
   healthy。
5. target/generation 退役时释放其读数、等待和队列资源；旧 generation callback
   不得更新新连接。
6. WebSocket 路径不得用 RTC 数值或旧 generation 代替自身队列事实。
7. JS snapshot 是异步投影；原生 admission 才是硬流控，JS getter 只做提前退让与
   观测，禁止 JS 虚构“原生已排空”。

高低水位是发送流控契约，写在唯一 owner `AndroidConnectionService.java`：
high 128,000，low 64,000。控制帧也不得绕过所有队列顺序持续积压；保留既有握手
gate 和生命周期顺序，不为 heartbeat 发第二条连接。

## 拥塞与真正断连分类

OPEN 拥塞：当前 backend 仍 OPEN，generation / network generation / channel epoch
有效，高水位阻止发送或 `sendText()` 返回 false 但未收到物理终止事实时，保留同一
待发帧，不消费、不推进成功计数、不触发 `transportFailure`、不递归新建多个 retry
timer；优先由 drain callback 续发，保留一个 200 ms 等待唤醒。

真正断连：DataChannel CLOSED、ICE FAILED、既有 disconnected grace 到期、真实
transport close/error、既有 heartbeat 失败合同成立、network generation 变更依法
退役。只有这些事实交现有 physical recovery owner。

不得把“字节多”“发送慢”“连续三次 false”直接视为物理失败。OPEN、低队列但持续
拒绝发送属于显式异常状态，记录并交既有监督器判断。容量错误与 overflow 计数在
正常负载下必须为零。

## 文件与 buffer-sync

- 上传保留 16 KiB 分块、8 chunk 累计 ACK 窗口与 native 批量上限；`sendChunk`
  类型为 `void | Promise<void>`，循环须 await 本次 dispatch 完成，异步失败进入
  原 transfer 错误/恢复流程。
- 下载每次 dispatch 前检查原 physical transport identity 与 OPEN 状态；背压等待
  使用单个可取消的 20 ms 调度，transport 退役、请求取消或 runtime dispose 时取消
  timer 并停止；send throw 不推进 index、不发 complete。
- buffer-sync 每块发送前重新检查背压；暂停时保留 frame 与 `nextChunkIndex`，后续
  从原位置继续，不生成不同 revision 的后半帧。

## 图与 resource

- `android-connection-service.graph.json`：`observe_transport_flow` 节点把
  `arc.transport_flow` 投影进 `project_service_snapshot`。
- `daemon-file-transfer-download.graph.json`：`admit_download_send` 节点与
  `arc.transport_flow` extract 保留单输入单输出，下载仍受既有 Phase3 验证。
- edge registry：保留既有 `daemon.file_transfer -> daemon.transport_subscriber`
  声明边，不新增额外边；下载 pacing 读 `TerminalSessionTransport.bufferedAmount`，
  水位常量由 `daemon.runtime` 提供，模块导入图保持无环。
- phase8/phase3 Rust operator 同步注册，Phase0/Phase1 gate 沿用项目入口。

## 非目标

不改变有序可靠 DataChannel（单一通道、ordered、无 maxRetransmits）；不改变
traversal tier 优先级、remote-window budget、后台电源策略；不在 MainActivity /
Application / 正常启动路径注入测试或诊断逻辑。
