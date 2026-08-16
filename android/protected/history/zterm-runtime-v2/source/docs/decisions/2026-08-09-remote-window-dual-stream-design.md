# 远程窗口双流推流设计（低码率总览 + 高码率主窗口 + 即时切换）

状态：已批准（design id：RWDS-20260809-A）
日期：2026-08-09

## 现状与问题

当前是**单流组合推流**：所有同 app 窗口平铺合成到一个 canvas（如 1160×385），一个 WebRTC 流传输。客户端用 CSS 裁切 video 元素放大显示焦点窗口。

问题：
1. 子窗口切换靠 CSS 裁切同一画布，切换瞬间有视觉跳变；点预览不切换时无兜底。
2. 主画面与子窗口共用同一低码率画布，主窗口清晰度受限。
3. 布局不符合预期：期望"3 小一大"（子窗口小预览在上、主窗口大画面在下）。

## 目标架构：双流

```
daemon
├─ 低码率总览流（overview）：全部窗口平铺合成 1080P canvas → WebRTC track（低码率，常驻）
└─ 高码率主窗口流（focus）：当前焦点窗口单独捕获全分辨率 → WebRTC track（高码率）

client
├─ video A（总览流）：上方子窗口小预览（≤3 个，可滚动）+ 主画面低清占位
├─ video B（主窗口流）：下方主窗口大画面（高清）
└─ 布局：一个大容器内，上 3 小、下 1 大，固定关系
```

### 切换流程（点预览切换主窗口）

1. 用户点子窗口预览 → 主画面**立即**用总览流（video A）CSS 裁切显示该窗口区域（低清，瞬间完成）。
2. 同时向 daemon 发 `update-target`：高码率流切换捕获该窗口。
3. 高码率流重建完成、video B ontrack 首帧就绪后，主画面**点到点切换**到 video B（高清）。
4. 切换瞬间低清占位 → 高清就绪后升级，无黑屏、无等待。

## daemon 改动

- `startStream` 扩展为可创建**双 track**：overview track（低码率）+ focus track（高码率）。
  - 方案 A：一个 RTCPeerConnection 加两个 video track（复用现有 offer/answer/ICE，两个 sender 分别 setParameters 控码率）。
  - 方案 B：两个独立 PeerConnection（码率隔离更彻底，但多一套握手/ICE 管理）。
- 双 capture 源：
  - overview：现有合成 canvas（全部窗口平铺），码率低（如 1-2 Mbps）。
  - focus：单窗口捕获（全分辨率），码率高（如 10-20 Mbps）。
- `update-target`：只切换 focus 流的目标窗口；overview 流保持不变。
- 输入坐标：
  - 主画面（focus 流）：client 直接发窗口屏幕坐标（normalized × 窗口尺寸 + 窗口左上），daemon 直接注入。
  - 总览/预览（overview 流）：点预览只触发切换，不注入输入。

### 高码率捕获方式（待定）

- 方案 A：继续 `SCScreenshotManager` 截图合成（只画主窗口，全分辨率高码率，~8fps）。
- 方案 B：重新验证 `SCStream` 单窗口（之前多流并发卡死，需单流场景复测）。

## client 改动

- 双 video 元素：
  - video A：总览流（用于子窗口小预览 + 主画面低清占位）。
  - video B：主窗口流（高清主画面）。
- 布局：一个大容器，上区为子窗口预览（3 小，超 3 个左右滚动），下区为主窗口容器，固定关系。
- 切换：点预览 → 主画面切 video A 裁切（低清）→ 请求 daemon 切换 focus 流 → video B 就绪后切 video B。
- 输入：主画面输入坐标直接按主窗口 bounds 计算，不再走画布映射。

## 切换失败 bug

现有点预览切换失败问题，在双流重构中一并解决（切换流程改为显式状态机：preview → lowres-pending → highres-ready，任一步失败回退低清并提示）。

## 实施锁定

- `client.remote_window_dual_stream_switch` 是切换状态、revision、低清 crop 投影和高清首帧提交的唯一 client owner。
- `daemon.remote_window_stream` 是 overview/focus capture、focus revision 校验和 ready 控制事件的唯一 daemon owner。
- 控制事件使用 typed control message；媒体帧不携带 request/revision/debug metadata。
- 旧的 `updateFocus -> ok:true` 无 ready 语义，正式实现中物理删除；只有匹配当前 revision、targetId、streamId 的 `focus-ready` 才允许提交高清投影。
- 错误、过期结果、关闭和 transport 断开均显式结束当前 switch；不以旧视频或伪成功补偿控制状态。

## 验收门禁

- `remote-window-dual-stream-runtime.test.ts`：正向证明 crop 先可见、首帧后提交；反向证明 stale/error/close 不提交高清。
- `remote-window-message-runtime.test.ts`：focus control message 只进入 dual-stream owner。
- `remote-window-stream-daemon.test.ts`：revision/target 校验、ready 事件和过期结果成对验证。
- 15t-1 真机回环：同一 `streamId` 下 overview 持续有帧，点击预览后先见 overview crop，再见 matching focus 首帧；日志记录 requestId/revision/streamId/phase。

## 风险与回退

- 双流带宽：总览低码率 + 主窗口高码率，总带宽可控（低清常驻 + 高清按需）。
- 高码率捕获不可用时必须返回显式 `focus-update` error；不得把 overview 当成隐式成功的高清流。
- overview/focus 的媒体资源保持独立；不得退回单流兼容路径。
