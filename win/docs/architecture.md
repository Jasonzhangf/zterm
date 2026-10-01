# zterm Windows Architecture

## Ownership

Windows is split into two layers:

1. Daemon backend: `daemon.windows_wezterm_backend`
   - Owner: `android/src/server/wezterm-backend.ts`
   - Selects WezTerm as the Windows terminal backend.
   - Treats WezTerm CLI output as input material only.
   - Produces ZTerm-owned absolute mirror snapshots and buffer protocol data.

2. Windows remote-access client target: `windows.remote_access_client`
  - Owner surface: `win/`
  - Owns Electron window, typed platform bridge, planned iTerm2-style shell layout, host/profile sidebar, session catalog projection, workspace projection, status bar, file browser projection, package integration, and Windows smoke evidence.
  - Reuses shared pane stage, app-layer workspace semantics, and terminal renderer.
  - DAGPipe graph: `android/docs/dagpipe/windows-remote-access-client.graph.json`.

## Allowed Paths

- Add Windows shell docs, profile/session/sidebar/workspace/status UI, package metadata, launcher, installer, and platform integration under `win/`.
- Keep Windows package-channel metadata under `win/package.json`, `win/build/`, and verifier scripts; internal alpha artifacts are unsigned unless a certificate-backed gate is added.
- Add Windows filesystem IO only behind the typed preload adapter; path/sort/preview decisions remain in shared `FileBrowserCore`.
- Update shared desktop pane/shell components only when the same behavior is intentionally shared with Mac.
- Update daemon backend only through `daemon.windows_wezterm_backend` owner paths.

## Forbidden Paths

- Do not copy `../wterm` runtime source into this repo.
- Do not implement a second terminal renderer under `win/`.
- Do not implement a second daemon mirror, buffer protocol, or terminal transport stack under `win/`.
- Do not fall back to tmux when the Windows WezTerm backend fails; expose the error.
- Do not import Mac filesystem IPC or duplicate file preview eligibility under `win/`.

## Validation Boundary

Windows backend completion requires:

- WezTerm backend and runtime unit tests.
- Backend selection and no-fallback tests.
- Mock daemon protocol smoke.
- Real Windows WezTerm remote and input smoke.
- Typecheck.

Windows remote-access client completion requires packaged Windows app smoke for sidebar profile selection, session catalog projection, split/tab workspace behavior, terminal source-to-DOM marker, file browser fixture, status bar projection, explicit failure projection, and runtime cleanup. Current static DAG coverage does not by itself prove these packaged gates.

## Desktop shell initialization

- DAGPipe graph: `android/docs/dagpipe/windows-remote-access-client.graph.json`
- Test design: `win/docs/testing/windows-desktop-shell-test-design.md`
- Electron main, CommonJS preload artifact, renderer, shell, profile/session sidebar, workspace, shared transport binding, shared renderer, and status bar bindings are anchored in the DAGPipe graph above.
- First extraction boundary: introduce a platform-neutral desktop bridge/runtime composition contract. Keep Mac local-tmux, filesystem, window-manager, and screenshot-helper IPC behind Mac adapters; Windows receives its own typed platform adapter.
