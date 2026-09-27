# Android DAGpipe Phase4 设计切片

状态：静态治理设计稿。`remote-window-stream-overlay.graph.json` 通过
validate/inspect 后，才进入 Rust Operator/parity/接线。

## 范围

Phase4 覆盖桌面窗口目录、远端窗口流启停、WebRTC 帧接收、浮层投影、触摸/鼠标
动作、质量预算、双流/焦点切换意图和截图/控制边界。

## 角色与身份

- `client.remote_window_overlay`：Android 端浮层投影、目录展示、触摸动作分类、
  质量意图、启动/停止意图。不拥有 daemon 捕获真源，不直接请求 transport。
- `daemon.remote_window_stream`：桌面窗口目录清单、捕获、编码发送、输入映射与
  OS 注入、canvas layout generation 唯一 owner。不得把 terminal mirror rows 当
  视频真相。
- `desktop.remote_window_stream`：桌面端媒体/捕获协作边界。只能经由 daemon
  stream owner 暴露的接口参与。

## 事件

- 目录：请求目标目录 → 返回窗口清单 → 投影浮层目录。
- 流起停：请求开始流 → 捕获就绪 → 编码并发送 → 客户端接收 → 浮层投影。
- 动作：触摸/鼠标动作 → 分类 → 源坐标映射 → daemon 注入输入。
- 质量：质量请求 → 预算调整 → 捕获重配。
- 双流/焦点：客户端只声明切换意图；daemon 维持 capture/layout/focus truth。

## 状态机

remote window 流：

- 空闲 → 建立中 → 推流中；推流中 → 重布局中 → 推流中；任何阶段可进入已停止。
- 建立失败和停止/超时都是显式失败终点。

overlay 投影：

- 关闭 → 目录加载中 → 已就绪 → 连接中 → 投影中；关闭或失败回关闭/失败终点。

## 单 session 与多 sessions

- 单 session：一个远端窗口一条流，一个浮层投影；触摸动作映射到唯一源坐标。
- 多 sessions / 多窗口：每个窗口目录项有独立 stream identity 和 layout
  generation；一个流失败不连坐 sibling 流；六图边不会让客户端去重写 daemon
  layout。

## 终态与非法转移

- 显式失败终点：`catalog-failed`、`capture-failed`、`stream-failed`、
  `input-failed`，以及停在已停止终态。
- 禁止：把 touched action 直接当物理发送成功；客户端计算或改写 macOS 坐标；
  用 terminal mirror rows 替代视频流真源。

## 数据契约

- `resource.remote_window_stream`
- `resource.remote_window_canvas_layout`
- `resource.remote_window_overlay`
- `resource.remote_window_touch_action`
- `resource.remote_window_focus_stream`
- `resource.remote_window_overview_stream`
- `resource.remote_window_quality_control`

## 验收

- `remote-window-stream-overlay.graph.json` 通过 `dagpipe graph validate/inspect`。
- 扩展后的 dagpipe gate 通过。
- 独立架构 review 对静态设计 PASS 后，才进入 Rust Operator/parity/接线。
- 接线前旧 TS 实现保留；parity 通过后再切换薄 bridge 为 active path。
