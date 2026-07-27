# Session Identity Exact-Match Plan（按 client-owned sessionId 精确查表）

Date: 2026-07-27

## 背景

`findReusableManagedSession` / `findReusableOpenTabSession` / `open-tab-intent.ts` 的 dedupe 当前按 `sessionName + daemonHostId + bridgeHost/bridgePort` 语义 key 复用。两条不同的 tmux session（一条原 `rcc`，一条原 `rcc2` 重命名产物）`sessionName` 相同时被当成同一 session 复用，client 再次进入时拿到别的 session 的 buffer。

按 zterm session identity 硬护栏（`~/.codex/AGENTS.md` / `terminal-buffer-truth` skill），sessionId 必须是 client-owned 稳定身份。复用只能精确按 `sessionId` 查表，不允许做 `sessionName` / `host` 模糊匹配。

UI 显示 / host 聚合（`useSessionHistoryStorage` / `useSessionOpenActions` 的 `sessionSemanticOwnersMatch`）继续保留按 owner 聚合，不在本切片。

## 1. 目标与验收标准

| # | 任务 | 验收标准 |
|---|---|---|
| S1 | `findReusableManagedSession` 改成精确 `sessionId` 查表 | 仅当传入参数显式带 `sessionId` 且 `sessions` 中存在同 id session 才返回；其它返回 `null`；`session-semantic-identity.ts` 调用次数 0；既有 `session-sync-helpers.test.ts` / `session-context-session-runtime.test.ts` 改写预期后绿 |
| S2 | `findReusableOpenTabSession` 同步 | 同样按 client-owned `sessionId` 精确查表；`open-tab-persistence.test.ts` 中两条"按 sessionName 复用"测试改写为"返回 null"预期后绿 |
| S3 | `open-tab-intent.ts` dedupe / 同 tab 复用改成精确 `sessionId` | `runtimeReuseKeys` 仅作 fallback 调试输出，**不**参与 dedupe；同名不同 id tab 互不覆盖；`open-tab-intent.test.ts` 既有 11+ case 全绿，新增"同名不同 id 互不合并"红测绿 |
| S4 | `tmux-session-picker-rows.ts` 改用 `sessionId` 作为抽屉 active 标记 key | `openTabBySessionName` 退化为 UI 显示字段，不参与 dedupe；保留"按 sessionName 显示在 picker"行为，避免把抽屉显示搞乱 |
| S5 | 不动 `session-semantic-identity.ts` 的 host 聚合路径 | `useSessionHistoryStorage` / `useSessionOpenActions:186` 的 `sessionSemanticOwnersMatch` 用途保持原样；module-registry `shared.terminal_types` / `client.connection_home` 不需要新规则 |
| S6 | 黑盒门禁：session identity 串线复现 | 加测试模拟"两个 sessionName 相同、sessionId 不同的 session"，断言：a) `findReusableManagedSession({sessionId})` 返回 null（缺 sessionId）；b) `findReusableOpenTabSession` 返回 null；c) open-tab-intent dedupe 不合并；d) `useSessionRenderBufferSnapshot` 不会读出另一个 session 的 buffer |

## 2. 范围与边界

**In scope**：`session-reconnect-helpers.ts` / `open-tab-persistence.ts` / `open-tab-intent.ts` / `tmux-session-picker-rows.ts`；对应测试改预期。

**Out of scope**：
- `session-semantic-identity.ts` 中 `sessionSemanticOwnersMatch` 用于 host 聚合（保留）。
- 任何 wire 协议语义变更。
- daemon / transport / buffer 任何逻辑改动。
- `TerminalPage` / drawer UI 整体拆分。

## 3. 设计原则

- 全局规则 + `coding-principals` skill 全部适用。
- 顺序守恒：resource / module / edge registry → 测试设计 → 红测 → 改 owner → 回归。
- 子切片：S1 → S2 → S3 → S4，每片独立 commit、独立回归。
- 删除 fallback：S1 后，传入无 `sessionId` 的 host 必须返回 null，禁止用 `sessionName+host` 兜底。

## 4. 技术方案与文件清单

### S1 `findReusableManagedSession` 改精确
- 新签名：`findReusableManagedSession({ sessions, sessionId?: string|null })`，返回 `sessions.find(s => s.id === sessionId) || null`。
- 同步移除 `session-semantic-identity.ts` 在该文件的 import 与调用。
- `session-sync-helpers.test.ts` 中"prefers active/connected managed session when multiple candidates match"测试改写为：传 `sessionId='s-active'` 时返回 `'s-active'`；传 `sessionId='s-missing'` 时返回 null；保留 `scoreReusableManagedSession` 与 `shouldOpenManagedSessionTransport` 测试不动。

### S2 `findReusableOpenTabSession` 改精确
- 调用方（`useSessionOpenActions.ts`）按 client 持有的 `sessionId` 传入；持久化恢复路径不再做语义 key 匹配。
- `open-tab-persistence.test.ts` 中两条预期改成"传 sessionId=null 或缺 sessionId 返回 null"。

### S3 `open-tab-intent.ts` dedupe 改精确
- `runtimeReuseKeys` 仅在 debug 日志输出。
- 同 tab 合并按 `sessionId === sessionId` 精确比较。
- 新增"同名不同 id 互不合并"红测。

### S4 `tmux-session-picker-rows.ts` 改用 sessionId
- `openTabBySessionName` 改名为 `openTabBySessionId`，key 为 `tab.sessionId`。
- 抽屉"按 sessionName 显示 / 排序"由外层 map 单独投影，不影响去重。

### S5 `session-semantic-identity.ts` 保留 host 聚合
- 仅记录"owner 维度匹配"路径还在使用，**不删**。

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| 现有测试预期"按 sessionName 复用"心智模型已写死 | 红测先行；先写出预期，再改 owner；不允许保留旧预期 |
| `useSessionOpenActions.ts` 多处 import `sessionSemanticOwnersMatch` 容易被误改 | grep 确认 import 用途，仅 host 聚合处保留 |
| 持久化 tab 恢复时若 `sessionId` 在 daemon 重启后丢失，UI 没法 attach | 由 `open-tab-restore.ts` 在 attach 前显式 `createSession`，不允许 fallback 到语义匹配 |

## 6. 测试计划

- 子切片验证栈：
  - S1: `session-sync-helpers.test.ts`（改预期）+ `session-context-session-runtime.test.ts` + `tsc --noEmit` + `test:feature-registry`
  - S2: `open-tab-persistence.test.ts`（改预期）+ `open-tab-apply-loop.test.ts` + 同上
  - S3: `open-tab-intent.test.ts`（新增红测）+ `useSessionOpenActions.test.tsx`
  - S4: `tmux-session-picker-rows.test.tsx`（新增）+ `TerminalPage.session-drawer.test.tsx`
- 收尾：`pnpm run type-check` + `pnpm run test:feature-registry -- --reporter dot` + `pnpm exec vitest run src/contexts src/lib/open-tab-persistence.test.ts src/lib/open-tab-intent.test.ts src/contexts/session-sync-helpers.test.ts --reporter dot`。

## 7. 实施顺序

```text
S1（改 owner，红测先行） → S2（持久化恢复路径同步）→ S3（dedupe）→ S4（picker UI）
```

## 8. 完成定义（DoD）

- S1-S6 验收标准全部达成。
- 既有测试改预期后全绿。
- `rg "sessionSemanticReuseMatch|sessionSemanticOwnersMatch" android/src/contexts/session-reconnect-helpers.ts android/src/lib/open-tab-persistence.ts android/src/lib/open-tab-intent.ts android/src/components/tmux/tmux-session-picker-rows.ts` 0 命中。
- `useSessionHistoryStorage` / `useSessionOpenActions` 的 host 聚合路径仍引用 `sessionSemanticOwnersMatch`。
- `tsc --noEmit` 0 错，`test:feature-registry` 72/72 绿。
- MEMORY.md 沉淀"sessionId 必须精确、不允许按 sessionName 复用"结论。

## 进度

- 2026-07-27 **实施起点**：goal 文档落盘，子切片按 S1→S4 顺序推进；不构建 APK，不动 daemon。
