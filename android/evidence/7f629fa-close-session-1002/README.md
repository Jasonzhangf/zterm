# 7f629fa close-session crash - L5 device evidence index

Candidate branch `codex/7f629fa-close-session-1002`, base
`fc9f390fede5648c584501f74c83f34188c10d0a`.
Raw JSON/logcat/screenshot stay in the local ignored evidence store
(`evidence/` is not committed, per `android/evidence/README.md`); this index
records reproducible commands and observed results bound to the candidate.

## Bug

`7f629fa` [P1] Closing session crashes React tree (`页面加载失败`) or returns
to launcher. Acceptance: closing the active tab must keep the React tree alive
and stay on TerminalPage (survivor tab, or the empty drawer state for the last
tab); no reload/unmount side effects outside the session lifecycle owner.

## Code under test

- `android/src/hooks/useOpenTabRuntime.ts` - close outgoing runtime before
  switching to the survivor; resume survivor with `explicit-resume`; keep the
  empty TerminalPage after the last tab closes.
- `android/src/lib/page-state.ts` - `resolvePersistedPageStateTruth` no longer
  rewrites `terminal + null activeSessionId` to connections, so the empty
  TerminalPage state is durable (ACTIVE_PAGE kind-only freeze, 2026-04-28).
- `android/src/hooks/useAppPageState.ts` - persist the live page kind; cold-start
  eligibility stays at the read guard.
- Tests: `useOpenTabRuntime.test.tsx`, `TerminalPage.tab-isolation.test.tsx`,
  `useAppPageState.test.tsx` (new regression "persists the live terminal page
  kind when the last runtime session closes").

## Candidate artifact

- versionName `0.1.3.3202`, versionCode `1100032020`, buildNumber `3202`
- APK `android/update-dist/zterm-0.1.3.3202.apk`
- sha256 `e89018a5ed76ddc1bde7acaa21c41bd13cf0add84dd4ea8dfed10819e37a0420`
- build entrypoint `bash android/scripts/build-android-debug.sh --resume-build 3202`
  (local update channel verified; Relay publish intentionally skipped,
  `ZTERM_PUBLISH_RELAY` unset)

## Device replay (emulator-5554)

Install preserved app data: `adb -s emulator-5554 install -r -d <apk>`;
`firstInstallTime=2026-09-29 19:28:42` retained, `dataDir=/data/user/0/com.zterm.android`.
Driven through the real WebView CDP entry (`webview_devtools_remote_<pid>`),
clicking the real drawer close buttons.

- Open two sessions (`AgentBrowser-1`, `default`).
- Close the active tab: `page={"kind":"terminal"}`, survivor `default` stays
  active, `terminal-stage-shell` present, no `页面加载失败`, 0 paused
  exceptions, 0 console errors.
- Close the last tab: `page={"kind":"terminal"}`, `active=null`, `tabs=[]`,
  `terminal-stage-shell` + `terminal-empty-pane-*` present, `connections-page`
  absent, no `页面加载失败`, 0 paused exceptions, 0 console errors. This is the
  persisted-truth fix: previously ACTIVE_PAGE was rewritten to
  `{"kind":"connections"}`.
- Same WebView PID across both closes (no crash/reload).
- Cold restart (`am force-stop` -> `am start`) routes to Connections with the
  stale terminal ACTIVE_PAGE cleared, so cold-start protection is intact.

Raw local evidence (ignored store):
`~/.collab/runs/p1-7f629fa-close-session-1002-r1/evidence/close-flows-3202.json`,
`close-flows-3202.logcat.txt`, `close-last-tab-3202.png`.

## Local gates

- `pnpm --dir android exec vitest run src/hooks/useAppPageState.test.tsx src/hooks/useOpenTabRuntime.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/App.first-paint.test.tsx src/App.first-paint.real-terminal.test.tsx --reporter dot`
  -> 5 files / 40 tests PASS
- `pnpm --dir android run type-check` -> PASS
- `pnpm --dir android run test:feature-registry -- --reporter dot` ->
  13 files / 107 tests PASS
- `git diff --check` -> clean
