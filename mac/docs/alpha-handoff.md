# Mac Alpha Handoff

## Status

The Mac client is ready for Jason internal alpha testing as an unsigned local package.

This is not a public release. It is not signed, not notarized, and has no updater, installer, or public distribution channel.

## Artifact

- Artifact: `mac/out/mac-arm64/ZTerm.app`
- Build command: `rtk pnpm --dir mac run package`
- Package mode: unsigned local Electron directory package
- Code signing: disabled by `CSC_IDENTITY_AUTO_DISCOVERY=false` and `build.mac.identity=null`

## Install / Open

- Use the local packaged app at `mac/out/mac-arm64/ZTerm.app`.
- Open directly from that path for internal alpha.
- Do not treat this artifact as a signed distributable or public release package.

## Verified Gates

Latest package handoff gate:

```bash
rtk pnpm --dir mac test -- --reporter dot
rtk pnpm --dir mac run type-check
rtk pnpm --dir mac run build
rtk pnpm --dir mac run package
rtk node --check mac/scripts/alpha-p0-packaged-smoke.mjs
rtk node --check mac/scripts/terminal-buffer-blackbox-gate.mjs
rtk git diff --check
```

The latest run passed with:

- Mac tests: 22 files / 146 tests passed
- Type-check: passed
- Build: passed
- Package: passed, producing `mac/out/mac-arm64/ZTerm.app`
- Smoke script syntax checks: passed
- Diff check: passed

## Packaged Evidence

Current P0 packaged evidence:

- Header / tab restore / reconnect controls: `mac/evidence/2026-07-05-mac-alpha-p0-closeout/header-restore-final2/`
- QuickConnect remote session discovery/open: `mac/evidence/2026-07-05-mac-alpha-p0-closeout/quick-connect-discovery-final3/`
- Remote server rail open: `mac/evidence/2026-07-05-mac-alpha-p0-closeout/server-rail-remote-open-final2/`
- Terminal buffer truth gate: `mac/evidence/2026-07-05-mac-alpha-p0-closeout/buffer-gate-all-t-a4-final/`
- Disconnect/reconnect: `mac/evidence/2026-07-05-mac-alpha-p0-closeout/disconnect-reconnect-final2/`
- Runtime split/local tmux isolation: `mac/evidence/2026-07-04-runtime-live-isolation-smoke/`
- Window lifecycle restore: `mac/evidence/2026-07-04-window-manager-smoke/`
- Local file browser preview: `mac/evidence/2026-07-04-file-browser-smoke/`
- Legacy workspace cleanup: `mac/evidence/2026-07-04-legacy-cleanup-smoke/`

Generated evidence under `mac/evidence/**` is local verification output and must remain ignored/unstaged.

## User Data Boundary

- The alpha handoff preserves existing local app/user data by default.
- No automatic user-data migration is performed in this handoff.
- No automatic user-data clearing is authorized by this handoff.
- Removing the local artifact means removing `mac/out/mac-arm64/ZTerm.app`; do not delete user data unless Jason explicitly authorizes it.

## Known Limitations

Remaining P1/P2 work:

- Settings surface for theme/font/cache/width mode
- Remote screenshot UI re-entry
- File transfer UI re-entry for upload/download
- Schedule modal re-entry
- Connection properties editing flow in the new owner model
- Public release work: signing, notarization, installer/DMG, updater, release notes for external users

## Alpha Scope

Covered for internal alpha:

- Local tmux terminal input/output
- Remote daemon session discovery/open
- Server rail explicit open
- Tab restore and active-only eager connect
- Terminal header status/disconnect/reconnect controls
- Terminal buffer/render correctness against tmux/pipe truth, including refreshing TUI and large-output reading
- Transport-owner disconnect/reconnect recovery
- Vertical split runtime isolation
- Local file browsing and preview
- Window lifecycle restore

Not covered as public release:

- Signed install flow
- Notarized distribution
- Auto-update
- User-data migration tooling
