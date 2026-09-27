# Android DAGpipe Phase5 设计切片

状态：静态治理设计稿。`android-session-shell-lifecycle.graph.json` 和
`android-session-preview-lattice.graph.json` 通过 validate/inspect 后，才进入
Rust Operator/parity/接线。

## 范围

Phase5 覆盖 open tab、session 激活/订阅、preview lattice、抽屉选择、焦点平移、
shell/quickbar/copy/IME 投影。输入归一与可靠发送继续由
`android.input_dispatch` 唯一 owner 承担，本图不重复建模。

## 角色与身份

- `client.app_shell`：打开/关闭 tab 的用户意图。
- `client.session_runtime`：激活 session 和订阅 body。
- `client.session_drawer_preview`：预览抽屉的选择与 focus 更新。
- `client.session_drawer_preview`：project lattice、select cell、pan focus 的
  owner；不切 active shell。
- `client.terminal_shell`：shell/quickbar/copy/键盘投影。

## 事件

- `android.session_shell_lifecycle`：打开 tab → 激活 session → 订阅 body →
  投影 shell → 投影 quickbar/copy/keyboard。
- `android.session_preview_lattice`：打开预览 → 投影 lattice；选择格子 →
  应用 focus；边缘平移 → 应用 focus。选择与平移是两条互斥路径，不强制同时满足。
- 失败终点由各 Operator 返回显式错误并由调用方状态机描述；图中不放置无条件执行的
  fake failure 节点。
- shell 投影 → quickbar/copy/keyboard 子投影。

## 状态机

preview 模式：

- 关闭 → 已打开；已打开可平移/选择；Back/取消回关闭并恢复入口投影。
- focus 选择只改变预览 focus，不移动 session，不切 active shell。

## 单 session 与多 sessions

- 单 session：一个 open tab 对应一个 session，一个 shell 投影。
- 多 sessions：lattice 每个坐标格独立；点击边缘格只平移 focus，不改变 active
  session；一个 session 失败不连坐 sibling。

## 终态与非法转移

- 状态机失败终点：tab-failed、subscribe-failed、preview-failed。
- 禁止：UI 直接开 socket、改写 buffer/renderer/transport；hidden pane 保留
  renderer 实例；preview 移动 session 或切换 active shell。

## 数据契约

- `resource.ui_projection`
- `resource.session_preview_lattice`
- `resource.session_preview_mode`
- `resource.terminal_shell_ui_contract`
- `resource.quickbar_ui_contract`
- `resource.platform_input_channel`

## 验收

- `android-session-shell-lifecycle.graph.json` 与
  `android-session-preview-lattice.graph.json` 通过 `dagpipe graph validate/inspect`。
- 扩展后的 dagpipe gate 通过。
- 独立架构 review 对静态设计 PASS 后，才进入 Rust Operator/parity/接线。
- 接线前旧 TS 实现保留；parity 通过后再切换薄 bridge 为 active path。
