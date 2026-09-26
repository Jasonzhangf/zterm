# Android DAGpipe Phase7 设计切片

状态：静态治理设计稿。`release-runtime-promotion.graph.json`、
`release-update-lifecycle.graph.json`、`observability-debug.graph.json` 通过
validate/inspect 后，才进入 Rust Operator/parity/接线。

## 范围

Phase7 覆盖 daemon runtime artifact 校验/提升/安装/启动、客户端更新检查/下载/
安装、以及 debug 采样/有界存储/导出/清理。

## 角色与身份

- `release.update_artifact`：更新产物校验、下载、安装。
- `release.daemon_artifact`：daemon artifact 提升。
- `release.runtime_home`：安装 runtime 到 runtime home。
- `daemon.runtime_entry`：启动已安装 runtime。
- `observability.debug_channel` / `client.debug_hub`：debug 授权、采样、有界
  存储、导出、清理。

## 事件

- 构建产物 → 校验哈希 → 提升 daemon artifact → 安装 runtime home → 启动 daemon。
- 检查更新 → 有更新 → 下载 → 校验 → 安装客户端更新。
- debug 采样授权 → 采样 → 有界存储 → 导出 / 过期清理。

## 状态机

更新：

- 空闲 → 检查中 → 可更新 → 已下载 → 已校验 → 已安装；校验失败进失败。

debug 通道：

- 关闭 → 待授权 → 已开启；授权拒绝/过期/显式关闭回关闭。

## 单 session 与多 sessions

- 单 runtime：一条 promotion 链、一次 runtime start。
- 多更新候选：按校验哈希唯一提升；debug 通道按 lease 独立，不共享 session 真源。

## 终态与非法转移

- 显式失败：digest-failed、download-failed、install-failed、debug-denied。
- 禁止 src 直接作为 runtime 执行；debug 不能成为业务控制真源。

## 数据契约

- `resource.runtime_home`
- `resource.daemon_runtime_artifact`
- `resource.release_update_artifact`
- `resource.debug_channel`
- `resource.observability_channel`
- `resource.client_debug_hub`
- `resource.daemon_debug_hub`

## 验收

- 三张 Phase7 graph 通过 `dagpipe graph validate/inspect`。
- 扩展后的 dagpipe gate 通过。
- 独立架构 review 对静态设计 PASS 后，才进入 Rust Operator/parity/接线。
- 接线前旧 TS 实现保留；parity 通过后再切换薄 bridge 为 active path。
