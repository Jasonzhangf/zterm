# Skeuomorphic Skin Device Evidence

Date: 2026-09-17

Scope: `client.ambient_controls` light/black skeuomorphic material states.

## Candidate

- Device: `emulator-5554`, `sdk_gphone64_arm64`
- Install: `adb -s emulator-5554 install -r <app-debug.apk>`
- Version: `0.1.3.3017`
- Version code: `1100030170`
- APK SHA-256: `db962d29925b8d2a90738a684db2374dde6e96379926fde83a4f193ea4d1c62e`
- APK size: `6876699` bytes
- Data preservation: `dataDir=/data/user/0/com.zterm.android`; `firstInstallTime=2026-09-08 06:36:23`

## Device State Matrix

Captured through WebView CDP against the installed APK:

| State | Black skin | Light skin |
| --- | --- | --- |
| Selected default | `bg=rgb(41,49,59)`, `color=rgb(124,240,173)`, active border/shadow | `bg=rgb(255,255,255)`, `color=rgb(11,107,69)`, active border/shadow |
| Selected hover | unchanged active bg/color/border/shadow | unchanged active bg/color/border/shadow |
| Selected pressed | pressed shadow `inset 0 2px 5px rgba(0,0,0,.78)` plus bottom highlight; `translateY(1px)` | pressed shadow `inset 0 2px 4px rgba(17,19,21,.20)` plus bottom highlight; `translateY(1px)` |
| Transparent flat row | hover and press keep `rgba(0,0,0,0)` background | hover and press keep `rgba(0,0,0,0)` background |
| Disabled control | `opacity=.42`, `cursor=not-allowed` | `opacity=.46`, `cursor=not-allowed` |
| Keyboard focus | `2px solid rgb(56,212,125)` | same focus token |

The press path is explicit state, not WebView `:active` timing: pointer down
sets `data-amb-pressed=true`, pointer up/cancel clears it, and CSS selects the
pressed material only for material controls. Flat controls stay outside that
state.

The `3017` CDP matrix also measured a normal (unselected) control with the
pointer released: light `bg=rgb(238,240,242)`, black `bg=rgb(32,37,45)`,
with hover increasing only the material tint. Disabled controls keep the
typed cursor and opacity values above. Focus was rechecked through the real
keyboard input-modality path (`data-zterm-input-modality=keyboard`) and
rendered a `2px solid` active-border ring.

## Screenshot Evidence

Screenshots remain in the local ignored evidence store:

- `android/evidence/2026-09-17-skeuomorphic-skin/settings-black-3017.png`
  - SHA-256: `78894c906162ff4e77f7767e5e866aef7ceaf5caba9420b0cdf00c062f93448b`
- `android/evidence/2026-09-17-skeuomorphic-skin/settings-light-3017.png`
  - SHA-256: `31ba974f1d15c742c51aa80e5aea80f4ce6fbc25b7c90f9e229672246bc2516e`

## Automated Gates

- `pnpm exec vitest run src/components/ambient/ambient-controls-render.test.tsx
  src/components/ambient/ambient-controls-truth.test.ts`: PASS, 25 tests
- `pnpm exec vitest run src/components/ambient/input-modality-runtime.test.ts
  src/pages/ConnectionsPage.test.tsx src/pages/ConnectionPropertiesPage.test.tsx
  src/pages/SettingsPage.theme.test.tsx
  src/components/terminal/TerminalHeader.test.tsx
  src/components/terminal/TerminalQuickBar.test.tsx
  src/components/terminal/TerminalSessionDrawer.test.tsx
  src/components/tmux/TmuxSessionPickerSheet.test.tsx
  src/components/terminal/SessionScheduleSheet.test.tsx
  src/components/terminal/FileTransferSheet.test.tsx
  src/lib/terminal-shell-skin.test.ts src/lib/module-import-graph-truth.test.ts
  src/lib/feature-registry-truth.test.ts`: PASS, 343 tests across 13 files
- `pnpm run test:terminal:shell-theme`: PASS, 228 tests
- `pnpm run type-check`: PASS
- `pnpm run build:android`: PASS
- OTA bundle verifier: PASS, including APK/manifest SHA, size, rollback, and
  next-normal replacement checks
- `git diff --check`: PASS

The public Relay update channel was not published for this candidate.

`RemoteWindowOverlay.test.tsx` is not an ambient-control gate. Its registered
owner is `terminal.remote_screenshot` / `desktop.remote_window_stream`, and it
already fails on the same source baseline with seven environment-sensitive
remote-window assertions; this slice does not touch that owner.
