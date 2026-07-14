# zterm Windows Architecture

## Ownership

Windows is split into two layers:

1. Daemon backend: `daemon.windows_wezterm_backend`
   - Owner: `android/src/server/wezterm-backend.ts`
   - Selects WezTerm as the Windows terminal backend.
   - Treats WezTerm CLI output as input material only.
   - Produces ZTerm-owned absolute mirror snapshots and buffer protocol data.

2. Windows desktop shell: `windows.desktop_shell`
   - Owner surface: `win/`
   - Owns window/menu/package/platform integration only.
   - Reuses shared pane stage, app-layer workspace semantics, and terminal renderer.

## Allowed Paths

- Add Windows shell docs, package metadata, launcher, installer, and platform integration under `win/`.
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

Windows desktop shell completion will require separate packaged Windows app smoke after the shell exists.

## Desktop shell initialization

- Test design: `win/docs/testing/windows-desktop-shell-test-design.md`
- Machine lifecycle: `win/docs/windows-desktop-shell-manifest.json`
- Electron main, CommonJS preload artifact, renderer, shell, shared transport binding, and shared renderer bindings are anchored in `win/docs/windows-desktop-shell-manifest.json`.
- First extraction boundary: introduce a platform-neutral desktop bridge/runtime composition contract. Keep Mac local-tmux, filesystem, window-manager, and screenshot-helper IPC behind Mac adapters; Windows receives its own typed platform adapter.
