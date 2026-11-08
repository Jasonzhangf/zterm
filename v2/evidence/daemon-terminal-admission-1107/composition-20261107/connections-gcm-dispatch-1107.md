# SUPERSEDED (2026-11-07) - do not dispatch from here

Jenny 已在裁决 m1794073275779-5913 / m1794073348389-5918 指定：不得从
daemon 任务编辑 connections；connections 的 catalog/consumability 修复单列为
`connections-public-runtime-1107`，并由 `shared-runtime-resolvability-1107`
（GCM，worktree `shared-runtime-resolvability-20261107`）提供真实 .mjs consumer。
本文件仅保留当时草案，禁止据此派发。以下为历史草案。

---

# GCM worker contract: connections scoped runtime fix (composition dependency)

Task: terminal-admission-composition-1107 的跨 owner 依赖修复。派发方 Emma（daemon composition owner，worktree `daemon-terminal-admission-20261107`）。执行方：独立 GCM worker。修复对象 worktree：`/Volumes/Intel/playground/zterm/worktrees/connections-cross-device-foundation-20261106`，分支 `connections-cross-device-foundation-20261106`，基线 `f99a61a8`。

## 目标

让 daemon（`node --experimental-strip-types`）能通过 connections 公开入口：(a) 成功 import，(b) 对已连接机器链读取当前 session catalog。仅修这两项，不改其他范围。

## 允许 / 禁止

允许：改 `v2/modules/connections/src/**`、`v2/modules/connections/tsconfig.json`、`v2/modules/connections/tests/**`。
禁止：改 daemon / members / accounts / android / packages 共享源；不 merge/push/publish/PR；不动 8899/3333/8801、tmux、15T、共享服务；不启动生产 daemon；不伪造回执；不降低断言。

## 必须完成

1. 语言边界：`v2/modules/connections/src/**` 内部相对 import 全部加 `.ts` 扩展名（当前 29 处缺扩展名，`node --experimental-strip-types` 返回 `ERR_MODULE_NOT_FOUND`，例如 `../public/link-port`、`../public/errors`、`../ports/transport`、`../channels/dispatch`、`../domain/link-state`）。`tsconfig.json` 追加 `allowImportingTsExtensions: true`（与 `moduleResolution: Bundler` 并存）。
2. `list-sessions` catalog 公共边：在 `V1TraversalTransport`/`ConnectionManager` 上新增机器链内 catalog 读取。用 `@zterm/shared/connection/protocol` 的 `buildTerminalMuxTargetMessage` 发送 `{ type: 'list-sessions', payload: { terminalBackend: 'tmux' } }`，按 `requestId` 关联回响应 `mux-target-message`，从 `payload.message.payload.sessionCatalog` / `.sessions` 规范化出 `{ name, backend, stableId }` 数组。对外签名建议 `manager.listSessions(link: LinkRef)`，或 transport handle 上的 `listSessions()`；二选一并在回传中说明所选签名。仅 terminal mux 支持；其他 kind 返回既有 `unsupported_channel` 语义。
3. 身份边界保持不变：`peerIdentityMatches` 严格 fail-closed（缺失/未验证/不一致 = `peer_identity_mismatch`）。禁止把缺失 `mux-ready.daemonHostId` 回退为 accounts 已验证身份。该字段由 `mux-ready-daemon-host-id-20261107` 提供。
4. 测试：保留并运行 `v2/modules/connections` 既有测试（至少 connection-manager 契约测试、real-entry 集成测试）。新增最小红测证明 strip-types 可 import、`listSessions` 对错误 kind/未连接链失败、catalog 正确解析。失败先红后绿。

## 验收与回传

回传必须含：改动文件清单、`node --experimental-strip-types` import 成功的原始输出、catalog 解析测试原始输出、既有测试原始结果、所选 `listSessions` 签名、未做/未验证项。缺证据标 `INCOMPLETE`，不得声称完成。

## 停止点

遇到真实阻塞（协议缺口、类型系统冲突、测试环境失败）保留原错并报告，不绕过、不扩范围。协调与验收由 Emma 负责并回传 master。
