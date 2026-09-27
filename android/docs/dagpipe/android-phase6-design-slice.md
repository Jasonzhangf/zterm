# Android DAGpipe Phase6 设计切片

状态：静态治理设计稿。`android-composition-plugin.graph.json`、
`android-control-command.graph.json`、`android-config-export.graph.json`、
`android-config-import.graph.json` 通过 validate/inspect 后，才进入 Rust
Operator/parity/接线。

## 范围

Phase6 覆盖 App 合成与 plugin 生命周期、控制命令路由/能力门禁、设置与配置分享。

## 角色与身份

- `client.composition_root`：校验并绑定 runtime ports，组合 App runtime。
- `client.plugin_host`：读取 manifest、注册能力与 UI slot、激活 plugin。
- `client.control_center`：控制命令鉴权、能力门禁、owner 路由、执行和结果。
- `settings.config_transfer`：导出配置。
- `connections.config_share`：导入/分享配置。

## 事件

- 合成：校验 ports → 组合 runtime → 读 plugin manifest → 注册能力 → 注册 UI
  slot → 激活 plugin。
- 控制：控制意图 → 鉴权 → 能力门禁 → owner 路由 → 执行结果。
- 配置导出图：导出请求 → 校验 → 导出；配置导入图：导入请求 → 校验 → 导入。
  两张图独立运行，导出/导入缺一不阻塞另一条。

## 状态机

plugin 生命周期：

- 未加载 → 已发现 → 已激活；激活错误进失败；失败可显式清理到已停用。

控制命令：

- 已接收 → 已授权 → 执行中 → 已完成；能力拒绝/超时进失败。

## 单 session 与多 sessions

- 单 session：一个 App runtime 一次合成，一个 control_center 路由一条命令。
- 多 sessions：plugin 能力和 UI slot 注册按 manifest 唯一；控制命令按 correlation
  独立，不连坐 sibling；配置分享按导入/导出意图独立。

## 终态与非法转移

- 显式失败：plugin-failed、command-failed、config-import-failed。
- 禁止：plugin/control 持有 terminal body、session transport、renderer truth。

## 数据契约

- `resource.client_composition_root`
- `resource.client_plugin_host`
- `resource.plugin_capability_registry`
- `resource.plugin_ui_slot_registry`
- `resource.client_control_center`
- `resource.client_settings_update`

## 验收

- 四张 Phase6 graph 通过 `dagpipe graph validate/inspect`。
- 扩展后的 dagpipe gate 通过。
- 独立架构 review 对静态设计 PASS 后，才进入 Rust Operator/parity/接线。
- 接线前旧 TS 实现保留；parity 通过后再切换薄 bridge 为 active path。
