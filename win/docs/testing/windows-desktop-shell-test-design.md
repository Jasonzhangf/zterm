# Windows desktop shell test design

## Scope

- Feature: `windows.desktop_shell`
- Status: single-session alpha implemented; packaged Windows L5 marker gate passed on 2026-07-14.
- Resource path: `resource.platform_terminal_surface -> resource.ui_projection`, with terminal data consumed through existing shared `resource.session_transport -> resource.client_sparse_buffer -> resource.renderer_window` owners.
- Shell owner: `win/` Electron entry, preload/platform bridge, packaging, and Windows-only integration.
- Shared owner: `packages/shared/` for intentionally cross-platform desktop workspace/render semantics.

## Ownership boundary

The Windows shell may own:

- Electron main-process window lifecycle and application menus.
- A typed Windows preload bridge for filesystem/window/platform operations.
- Windows packaging metadata, installer configuration, and packaged smoke entry.
- Composition of existing shared workspace, pane stage, connection, and terminal renderer modules.

The Windows shell must not own:

- daemon/backend selection, WezTerm pane truth, mirror capture, or buffer protocol;
- a copied terminal renderer, sparse-buffer manager, or transport implementation;
- Mac local-tmux IPC, `window.ztermMac`, Mac window manager, screenshot helper, or Mac filesystem bridge;
- a fallback from Windows daemon/WezTerm failure to local tmux.

## Lifecycle

1. Electron main creates one Windows application window and loads the renderer entry.
2. Preload exposes one typed, least-privilege Windows platform bridge.
3. Renderer creates the desktop shell and shared workspace projection.
4. Session transport connects to the configured daemon through the existing shared protocol.
5. Shared sparse-buffer truth feeds the shared terminal renderer inside the active pane.
6. Window close disposes renderer subscriptions and platform listeners without closing daemon/backend truth.

## White-box gates

- Static architecture gate proves no `window.ztermMac`, Mac Electron module, local-tmux transport, daemon source, mirror source, or renderer copy is imported by `win/`.
- Static architecture gate proves the Windows preload source is `.cts` and Electron main loads `preload.cjs`, because packaged Electron sandbox preload loading is CommonJS.
- Platform bridge types and preload implementation expose only declared Windows operations.
- Shell composition owns no buffer parsing, terminal cell mutation, reconnect state machine, or backend selection.
- Window/listener cleanup is paired and idempotent.
- Package entry, renderer entry, preload entry, and build config resolve to real files.

## Module black-box gates

- Renderer entry mounts the Windows desktop shell as the only production entrypoint.
- Shell can open a configured daemon session and render a supplied shared terminal projection.
- Shell can list, create, select, and close daemon sessions through the existing control protocol, with no Windows-only daemon protocol fork.
- Visible-range requests are blocked until the first daemon `buffer-sync` has made the mirror ready; connecting state must not emit `buffer-sync-request`.
- Pane/tab operations preserve shared workspace identity and do not create another runtime per projection.
- Filesystem/window bridge errors surface explicitly; missing bridge capability is not converted to success.
- Closing the app window removes bridge subscriptions and renderer observers.

## Project black-box gates

- Build/typecheck/tests pass from the repository workspace.
- Packaged Windows app starts on the real Windows machine and exposes one visible, interactive window.
- Real daemon path: packaged app -> `100.75.122.121:3333` active profile -> session ticket/connect -> decoded current buffer -> input echo.
- Source/target terminal marker comparison is automatic; manual visual confirmation is supplemental only.
- Window close/reopen preserves daemon session truth and does not leak client transports.

## Positive and negative pairs

- Positive: valid daemon profile connects and renders current buffer. Negative: invalid endpoint/auth produces explicit connection error and no tmux fallback.
- Positive: session refresh/create/close returns the daemon session list. Negative: daemon control errors remain visible and do not mutate the selected target as success.
- Positive: declared filesystem operation returns a real Windows path/result. Negative: denied/missing path returns an explicit error and no fake empty success.
- Positive: app close disposes its transport/listeners. Negative: daemon session and WezTerm pane remain unless the user explicitly closes that session.
- Positive: packaged app loads the Windows preload bridge. Negative: `window.ztermMac` is absent and cannot satisfy a Windows operation.

## Completion signal

The single-session alpha is complete when the registry, resource binding, function map, lifecycle manifest, and this test design agree, all real symbols are anchored, and packaged Windows L5 smoke passes. Multi-session workspace, filesystem browser, installer/signing, and Ctrl+C console-control semantics remain separate follow-up features.
