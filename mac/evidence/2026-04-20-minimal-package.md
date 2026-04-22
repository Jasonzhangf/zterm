# 2026-04-20 Mac minimal package evidence

## Verified

- `pnpm --filter @zterm/mac type-check`
- `pnpm --filter @zterm/mac build`
- `pnpm --filter @zterm/mac package`
- browser live render validation with local mock bridge
- bridge endpoint normalization validation

## Artifact

- `/Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app`

## Runtime check

- `open /Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app`
- Window state confirmed via Computer Use
- Current stage visible as single-row multi-column layout with vertical split panes
- Current runtime content includes real page slots:
  - Connections slot
  - Terminal slot
  - Details slot (available when column count reaches 3)

## Connection config port evidence

### Shared truth moved

- `packages/shared/src/connection/types.ts`
- `packages/shared/src/connection/bridge-settings.ts`
- `packages/shared/src/connection/connection-target.ts`
- `packages/shared/src/connection/bridge-url.ts`
- `packages/shared/src/connection/tmux-sessions.ts`
- `packages/shared/src/react/use-host-storage.ts`
- `packages/shared/src/react/use-bridge-settings-storage.ts`

### Mac flow wired

- `mac/src/App.tsx`
- `mac/src/pages/ConnectionsSlot.tsx`
- `mac/src/pages/DetailsSlot.tsx`
- `mac/src/pages/TerminalSlot.tsx`

### Verification

- `pnpm --filter @zterm/mac type-check`
- `pnpm --filter @zterm/mac package`
- `pnpm --filter @zterm/mac dev`
- Browser verification at `http://127.0.0.1:5174/` confirmed:
  - Details pane renders Android-style sections:
    - General
    - Tmux Session
    - Remembered Servers
    - Connection
    - Detected Tmux Sessions
    - Terminal
    - Appearance
  - Saving a new connection updates:
    - Connections list
    - Terminal pane summary
    - Remembered Servers block

### Follow-up fix: session discovery != connect

- Root cause:
  - Mac 的 `Detected Tmux Sessions` 最初只调用了 `list-sessions`
  - 没有真正复用 Android 的 websocket `connect` 协议
- Fix:
  - added `packages/shared/src/connection/protocol.ts`
  - added `packages/shared/src/connection/bridge-connection.ts`
  - Mac Details pane now sends:
    - `connect(payload)`
    - `stream-mode(active)`
- Verification:
  - `pnpm --filter @zterm/mac type-check`
  - `pnpm --filter @zterm/mac package`

## Live terminal render evidence

### Browser renderer evidence

- Browser target: `http://127.0.0.1:5174/`
- Local mock bridge target: `ws://127.0.0.1:4333`
- Verified renderer state:
  - status: `connected`
  - session id visible: `mock-session-001`
  - buffer lines visible in terminal pane
  - rendered snapshot text includes:
    - `boot: shared terminal render wired`
    - `boot: bridge session reducer active`

### Mock bridge traffic evidence

- mock bridge received:
  - `connect`
  - `stream-mode`
  - client heartbeat `ping`
- this proves Mac renderer no longer stops at session discovery; it now enters real websocket attach flow

## Bridge endpoint normalization evidence

### Root cause

- 当 `bridgeHost` 直接填写 `ws://127.0.0.1:4333` 时，旧文案/旧 key 仍会继续拼接独立 `bridgePort`
- UI 会出现伪造目标：
  - `ws://127.0.0.1:4333:3334333`

### Fix

- added shared endpoint truth:
  - `packages/shared/src/connection/bridge-endpoint.ts`
- reused by:
  - `bridge-url.ts`
  - `connection-target.ts`
  - `bridge-settings.ts`
  - `use-host-storage.ts`
  - Mac `App.tsx` / `DetailsSlot.tsx` / `TerminalSlot.tsx`

### Validation

- direct source-level probe result:
  - endpoint: `ws://127.0.0.1:4333`
  - presetId: `ws://127.0.0.1:4333`
  - storedPort: `4333`
- packaged artifact contains new renderer string:
  - `Shared connection flow + live terminal render`

## Packaged app single-instance rule

- packaged app re-validation must use:
  1. quit old `ZTerm`
  2. confirm no old main process remains
  3. open packaged `.app`
- reason:
  - multiple desktop instances can make old windows look like “new package did not update”

## Single-instance packaged app re-check

- verified no old packaged main process remained before reopen
- reopened exactly one instance with:
  - `open /Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app`
- Computer Use confirmed the reopened packaged window now shows latest renderer truth:
  - title: `Shared connection flow + live terminal render`
  - terminal copy: `Primary stage now renders live bridge snapshots instead of mock text.`
  - empty-state copy: `Terminal render 已接入`

## Workspace split preset smoke

### Goal

- 按 Jason 最新冻结，把桌面 workspace 从“固定右侧详情”收成：
  - 左侧窄 connections rail
  - 右侧按比例切换的 vertical split workspace
  - split preset 类似 iTerm2：`1 / 2 / 3`

### Verification

- rebuilt packaged app:
  - `pnpm --filter @zterm/mac type-check`
  - `pnpm --filter @zterm/mac build`
  - `pnpm --filter @zterm/mac package`
- single-instance reopen:
  - `osascript -e 'if application "ZTerm" is running then tell application "ZTerm" to quit'`
  - `open /Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app`
- Computer Use verified:
  - 顶部出现 split preset buttons: `1 / 2 / 3`
  - preset `2` 时：右侧为 `terminal + inspector`
  - preset `3` 时：右侧为 `terminal + terminal + inspector`
- screenshots:
  - `/Volumes/extension/code/zterm/mac/evidence/2026-04-20-workspace-split-dual.png`
  - `/Volumes/extension/code/zterm/mac/evidence/2026-04-20-workspace-split-presets.png`

### Conclusion

- packaged `.app` 已具备最小可选 vertical split workspace
- 当前仍保持 `single runtime · multi tabs`
- split 只做比例 preset，不宣称自由拖拽 closeout

## Packaged app live connect smoke

### Flow

- reused the same single packaged `ZTerm.app` instance
- expanded window to `wide-3col`, so Details pane stayed visible
- edited current target in packaged app:
  - name: `Mock Bridge`
  - session: `main`
  - host: `ws://127.0.0.1:4333`
  - token: `mock-token`
- clicked packaged-app `Connect`

### Packaged UI evidence

- packaged app terminal state changed to:
  - `CONNECTED`
  - target label: `ws://127.0.0.1:4333 · main`
  - session id: `mock-session-001`
  - buffer lines: `10`
- packaged terminal pane rendered snapshot text, including:
  - `boot: shared terminal render wired`
  - `boot: bridge session reducer active`

### Mock bridge evidence

- local mock bridge received:
  - `connect`
  - `stream-mode`
  - `resize`
  - later heartbeat `ping`

### Conclusion

- this confirms the packaged `.app` is not only showing the updated shell
- the packaged renderer can complete:
  - websocket attach
  - shared buffer state update
  - terminal snapshot render
  - heartbeat maintenance

## Packaged form normalization smoke

### Goal

- avoid UI drift where:
  - host field is explicit `ws://host:port`
  - but port field still shows an old stale number

### Validation

- rebuilt packaged app after adding host-change normalization
- reopened packaged app in single-instance mode
- expanded to `wide-3col`
- changed only:
  - `Bridge Host / Tailscale IP` -> `ws://127.0.0.1:4333`
- packaged app immediately updated:
  - `Bridge Port` -> `4333`

### Conclusion

- explicit websocket URL is now the visible form truth in packaged app too
- users no longer need to manually retype the same port after entering `ws://host:port`

## Tabby-inspired shell smoke

### Reference intent

- Mac 壳层参考 Tabby 的官方产品特征：
  - 紧凑桌面终端 chrome
  - 顶部 tab strip
  - 左侧 profile / session rail
  - 主 terminal canvas 优先
- 但不改变仓库唯一布局真源：
  - 仍然是一行多列
  - 仍然是垂直分屏

### Validation

- rebuilt packaged app:
  - `pnpm --filter @zterm/mac type-check`
  - `pnpm --filter @zterm/mac build`
  - `pnpm --filter @zterm/mac package`
- quit old app first:
  - `osascript -e 'tell application "ZTerm" to quit'`
- reopened exactly one packaged instance:
  - `open /Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app`
- Computer Use confirmed packaged UI now shows:
  - compact top chrome with traffic-light style controls
  - top workspace tab strip
  - left profile-style connections rail
  - compact pane headers
  - terminal-first main surface

### Conclusion

- current packaged Mac shell has moved from “docs/demo stage” toward “desktop terminal shell”
- visual reference now aligns more closely with Tabby, while keeping the repo’s single-row multi-column vertical-split truth

## Real shell tabs + inspector smoke

### Goal

- stop treating the top tab strip as static decoration
- make it reflect real terminal / inspector state
- make 2-col packaged app switch secondary pane via shell tabs

### Validation

- rebuilt and repackaged:
  - `pnpm --filter @zterm/mac type-check`
  - `pnpm --filter @zterm/mac build`
  - `pnpm --filter @zterm/mac package`
- single-instance reopen:
  - quit old `ZTerm`
  - `open /Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app`
- Computer Use confirmed packaged app shows dynamic shell tabs such as:
  - `Connections · 1`
  - `wterm`
  - `Inspector · 100.86.84.63`
- clicked packaged `Inspector` shell tab:
  - right column switched from terminal pane to details inspector
  - packaged UI showed compact inspector summary with:
    - target
    - session
    - bridge status
- clicked packaged `wterm` shell tab again:
  - right column switched back to terminal pane

### Conclusion

- top shell tabs are now stateful and actionable in packaged app
- Mac 2-col desktop shell now behaves more like a real terminal client instead of a static stage

## Open target tabs smoke

### Goal

- verify shell tabs are true open-target tabs rather than only terminal/inspector toggles
- keep the scope honest as `single runtime · multi tabs`

### Validation

- packaged app already reopened in single-instance mode
- packaged top shell initially showed:
  - `Connections · 1`
  - `wterm`
  - close button for `wterm`
  - `+`
  - inspector tab
- clicked packaged `+`:
  - shell created a `New connection` tab
  - right column switched to inspector create flow
- clicked packaged close button for `wterm`:
  - `wterm` tab disappeared from shell
  - shell remained in `New connection` inspector tab
- clicked saved-target reopen button `↗` in Connections list:
  - `wterm` tab reappeared
  - right column switched back to terminal
  - runtime reattached and terminal entered `CONNECTED`

### Conclusion

- packaged Mac shell now supports:
  - open saved target as tab
  - create new tab entry
  - close active tab
  - reopen closed target tab
- current truth is still explicit:
  - multiple open target tabs
  - one live runtime at a time

## Layout cleanup smoke

### Goal

- remove the cluttered equal-width / double-tab / over-decorated shell feeling
- make the packaged app read as a terminal-first desktop client

### Validation

- rebuilt and repackaged:
  - `pnpm --filter @zterm/mac type-check`
  - `pnpm --filter @zterm/mac build`
  - `pnpm --filter @zterm/mac package`
- reopened packaged app in single-instance mode
- Computer Use confirmed:
  - connections rail is visibly narrower than terminal column
  - terminal column is now the primary reading surface
  - top chrome and shell tabs are thinner
  - terminal pane no longer has the extra nested pseudo-tab / toolbar layer

### Conclusion

- packaged layout is materially cleaner than the previous equal-width, over-layered shell
- current shell now reads as terminal-first instead of a dense demo panel stack
