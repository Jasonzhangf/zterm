# Remote Window 双流切换测试设计

## feature / owner

- `feature_id`: `desktop.remote_window_stream`
- switch owner: `client.remote_window_dual_stream_switch`
- media/control owner: `daemon.remote_window_stream` + `shared.protocol`
- design: `RWDS-20260809-A`

## 生命周期与白盒测试

1. `idle -> switch-requested -> overview-crop-visible -> focus-updating -> focus-ready -> focus-committed`。
2. focus result 的 `requestId`、`revision`、`targetId`、`streamId` 任一不匹配时拒绝提交。
3. 新 revision 开始后，旧 revision 的 ready/error/close 不得改变当前 projection。
4. focus error、overview error、transport close 都产生显式 error state。

## 模块黑盒

- message runtime 将 typed focus result 投影给 dual-stream switch owner；不得直接改 overlay 的高清可见状态。
- daemon update-focus 必须先校验 stream/target/revision，再发 accepted；首个真实 focus frame 后才发 ready。
- overview capture 不因 focus update 重建或停止。

## 项目黑盒 / 真机

- 15t-1 / `100.104.163.65:5555`：catalog、start、overview frame、focus update、first-frame commit、stop。
- 记录 WebRTC track identity、video dimensions、requestId/revision/streamId/phase。
- 反向场景：注入旧 revision ready、focus update error、关闭时 late ready，均不得黑屏伪成功或提交错误窗口。

## 已知缺口

- 当前设备侧基线已有 catalog Swift 编译错误；正式修复后必须重新安装 daemon 并复测。
- 尚未有稳定的 focus 首帧回执；本次实现将其纳入 typed control side-channel。
