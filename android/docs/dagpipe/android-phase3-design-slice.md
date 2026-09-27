# Android DAGpipe Phase3 设计切片

状态：静态治理设计稿。daemon 输入/调度图与五张独立传输/媒体图通过
validate/inspect 后，才进入 Rust Operator/parity/接线。

## 范围

Phase3 覆盖 daemon 输入队列、时间调度、会话空闲事实，以及文件浏览/上传/下载、
附件投递、远端截图请求到结果。

## 角色与身份

- `daemon.input_queue`：频道输入入队、去重、ACK/NACK 与写后端。它不拥有
  客户端 session/foreground/viewport truth。
- `terminal.schedule`：时间调度任务计划与触发。不把调度状态写入 payload 或
  debug 日志。
- `daemon.session_idle_detection`：发布空闲事实，不决定客户端 UI。
- `daemon.file_transfer`：目录读取、上传分段 ACK、下载写本机。客户端不猜测
  daemon 文件系统。
- `daemon.attachment_delivery`：附件投递到目标，回执不等于目标消费。
- `terminal.remote_screenshot`：远端截图请求到结果，不持有 terminal mirror
  正文真源。
- `client.file_browser`：只投影 daemon 目录列表为 UI view，不直接开 socket
  或改写 buffer/transport。

## 事件

- `daemon.input_schedule` 分为两条独立链路：
  - 输入执行链：enqueue_channel_input → ack_input → write_backend_input。
  - 定时调度链：plan_schedule → fire_schedule → dispatch_backend_input。
  - 交互式键盘输入不得直接连到定时计划或空闲事实发布；空闲事实发布继续由
    `daemon.connection_channel_catalog` 的 `daemon.session_idle_detection.publish@0.1`
    承担，不在输入/调度图中重定义同一 Operator 签名。
- `daemon.file_transfer_browse`：validate_browse_request → list_directory →
  project_file_browser_view。
- `daemon.file_transfer_upload`：validate_upload → dispatch_upload_segment →
  ack_upload_segment。
- `daemon.file_transfer_download`：validate_download → download_segment →
  ack_download_chunk。
- `daemon.attachment_delivery`：validate_attachment_request →
  enqueue_attachment → dispatch_attachment → publish_attachment_receipt。
- `terminal.remote_screenshot`：validate_screenshot_request →
  capture_remote_screenshot → store_screenshot_result。

## 状态机

输入队列：

- `pending` → `acknowledged` → `written`，或 `pending` → `nack`。
- 同一个输入 item 最多写后端一次；重复 ACK 不得改变已写状态。

文件传输：

- 上传 `validating` → `uploading` → `ack-segment` → `complete` 或 `failed`。
- 下载 `validating` → `downloading` → `chunk-received` → `complete` 或 `failed`。
- 附件 `queued` → `delivered` 是传输终点；目标消费是独立证据，不得把
  delivered 当 consumed。

## 单 session 与多 sessions

- 单 session：一条 channel 的输入按有序队列单独 ACK/write。
- 多 sessions：每个 channel 有独立 input queue、file browse view 和
  attachment receipt；一个 session 的传输失败不得连坐 sibling channel。

## 终态与非法转移

- `nack`、`upload-failed`、`download-failed`、`attachment-failed`、
  `screenshot-failed` 是显式失败终点。
- 禁止从 `nack` 直接回到 `acknowledged`；禁止把附件 `delivered` 当目标消费。
- 禁止客户端从 file_browser_view 反推 daemon 文件系统真源。

## 数据契约

- `resource.daemon_input_queue`
- `resource.schedule_job`
- `resource.session_idle_facts`
- `resource.file_transfer`
- `resource.remote_screenshot`
- `resource.attachment_store`
- `resource.attachment_delivery`
- `resource.client_file_browser`
- `resource.target_mux_request`

## 验收

- `daemon.input_schedule` 与五张独立传输/媒体图通过
  `dagpipe graph validate/inspect`。
- 扩展后的 dagpipe gate 全部通过。
- 独立架构 review 对静态设计 PASS 后，才进入 Rust Operator/parity/接线。
- 接线前旧 TS 实现保留；parity 通过后再切换薄 bridge 为 active path。
