# Fix Design Report: Terminal Source Adapter + Visible Repair Ledger

Design ID: `terminal-buffer-render-20260814-visible-repair-ledger`

Date: 2026-08-14

## 1. Decision

Jason 已确认开始实现。本轮把 terminal mirror 与不同 source 隔离，并修
mirror 传输/刷新中的永久 stale 与间歇漏行收敛。

变更面：

1. 引入统一 `TerminalSourceAdapter`，daemon mirror 只消费 adapter 产出的
   authoritative mirror snapshot，不再由 mirror 主链散点判断 tmux / Herdr /
   WezTerm 的实现差异。
2. 引入 per-session visible repair ledger，替换当前
   `session-tail-refresh-store` 的单条 visible repair 记录 + 5s cooldown。

## 2. Root Cause And Owner

现场症状：

- 白色字体背景竖纹：renderer 列宽测量产生 subpixel seam，独立于本设计。
- 间歇漏行：`buffer-sync` 为 sparse 时，client 局部窗口外旧 non-gap 行仍保留。
- 永久 stale：repair 已 dispatch 但响应丢失/不完整/被同一 visible window +
  tail 的 5s cooldown 压住后，后续 same-tail sparse revision 不再重发 repair。

唯一 owner：

- `terminal.buffer_render`
- daemon side: `resource.terminal_backend` -> `resource.mirror_store`
- client side: `resource.client_sparse_buffer` + `resource.renderer_window`
- 代码 owner:
  - `src/server/terminal-source-adapter.ts`（新）
  - `src/server/terminal-mirror-capture.ts`
  - `src/server/terminal-control-runtime.ts`
  - `src/server/terminal-mirror-runtime.ts`
  - `src/contexts/session-context-buffer-runtime.ts`
  - `src/lib/session-tail-refresh-store.ts`

## 3. Adapter Contract

```ts
interface TerminalSourceMirrorSnapshot {
  revision: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cols: number;
  rows: number;
  cursorKeysApp: boolean;
  cursor: TerminalCursorState | null;
  availableStartIndex?: number;
  availableEndIndex?: number;
  captureDurationMs?: number;
  canonicalizeDurationMs?: number;
  capturedLineCount?: number;
  canonicalLineCount?: number;
  totalAvailableLines?: number;
  visibleTopIndex?: number;
  source?: TerminalSourceKind;
}

interface TerminalSourceAdapter {
  kind?: TerminalSourceKind;
  listSessions(): TerminalSourceSession[];
  createSession(input?): TerminalSourceSession;
  readSnapshot(sessionName: string): Promise<TerminalSourceMirrorSnapshot>;
  writeInput(sessionName: string, input: Buffer | string): void;
  resizeSession?(sessionName: string, geometry: { cols: number; rows: number }): void;
  supportsSessionRename?: boolean;
  renameSession?(sessionName: string, nextSessionName: string): string;
  closeSession(sessionName: string): void;
  readCurrentPath(sessionName: string): string;
}
```

硬规则：

- adapter 是 daemon source 侧唯一读写事实；mirror store 不得直接执行 tmux /
  Herdr / WezTerm source 命令。
- `TerminalSourceMirrorSnapshot` 的 absolute range 只能由 source adapter 或
  source-side canonicalizer 产出；daemon mirror 不得用内容 overlap 推断 anchor。
- 未知/不支持 source 显式失败，禁止 fallback 到 tmux。
- adapter 不得携带 client viewport / follow / reading / active tab 心智。
- Herdr `seq` 与 WezTerm pane 内部 revision 都不得直接变成 zterm mirror
  revision；adapter snapshot 的 `revision` 只是 source-side 信息字段，
  `ztermRevision` 仍由 mirror writer 唯一推进。

## 4. Visible Repair Ledger

用 per-session 有序 map 替代单条 cooldown：

```text
key   = sessionId + visibleRange + tailEndIndex + targetRevision
state = pending -> dispatched -> fulfilled
        dispatched -> stale -> dispatched（有界重试）
        pending 在 send-fail / no-socket 时保留
```

清除条件：

- 完整覆盖 visible window 的 authoritative `buffer-sync` apply；
- 显式 session cleanup；
- authoritative revision epoch reset。

禁止：

- 用全局 `gapRanges` 或 `localRevision == daemonHeadRevision` 证明行级新鲜；
- repair 未实际写入 wire 时标记 dispatched；
- 响应不完整时清 ledger 或永远 cooldown；
- 每次 sparse advance 都无限重发同一 ledger。

fulfilled / superseded 只是历史账目，不得抑制新的 repair demand；只有同一
visible window 的 active `pending` / `dispatched` 且未超过 stale timeout 才允许
在重发窗口内抑制。后续 sparse advance 触发新 demand 时，应创建新 ledger entry
继续收敛，而不是被已经完成的历史 entry 永久压住。

完整 authoritative body apply 只精确 fulfill 仍 active 的 ledger entry：按
entry 自身 `targetRevision` 标记 fulfilled，不创建以 response revision 为 key
的合成 entry；`payloadRevision >= entry.targetRevision` 且 payload 连续覆盖
entry 的 request range 才满足。superseded / 已 fulfilled 的历史 entry 不再改写。

## 5. Tests

L1 red/green:

- adapter: tmux / Herdr / WezTerm 同一 source fixture 产出同一
  `TerminalSourceMirrorSnapshot` 语义；
- adapter: unsupported source 显式失败，无 tmux fallback；
- ledger: repair dispatch 丢失后，same-tail sparse patch 仍收敛；
- ledger: repair 响应不完整时仍 pending/dispatch；
- ledger: 完整响应只 clear 一次；
- ledger: unchanged visible rows 不 spam。

## 6. Non-Goals

- 白色竖纹：归 renderer `measureTerminalViewport()`，作为独立 renderer fixture。
- Herdr changed-row delta、tmux hot-range capture：本轮 adapter 骨架后可继续在
  adapter 内部优化，不改变 mirror wire 语义。

## 7. Verification Gates

- L0: `test:feature-registry`、`tsc --noEmit`
- L1: adapter + buffer runtime + tail refresh store focused tests
- L2: `daemon:mirror:close-loop`
- L3: Mac client transport/runtime gate
- L5: Android APK 构建/安装/OTA + online device smoke
- Review: `oauth -> cc -> tcm` codex review gate
