# zterm Windows Spec

## Scope

Windows support includes the production-selectable WezTerm daemon backend and a Windows desktop remote-access client target. The planned UI reference is iTerm2 information architecture: persistent server/session sidebar, pane workspace, terminal tabs, and status bar.

## Product Boundary

- `win/` owns the Windows desktop shell target: Electron window, typed platform bridge, planned profile/session sidebar, planned workspace/statusbar projection, package integration, and Windows-specific smoke evidence.
- `android/src/server/wezterm-backend.ts` owns the Windows WezTerm daemon backend contract.
- Shared pane/layout/rendering behavior must come from existing shared code. `win/` must not copy terminal runtime, daemon mirror, buffer protocol, renderer logic, or daemon session truth.
- DAGPipe graph truth for this client is `android/docs/dagpipe/windows-remote-access-client.graph.json`; Windows docs and skills must route through it before product-code changes.

## Alpha Acceptance

- Windows daemon backend passes local unit tests, mock protocol smoke, real Windows remote smoke, real input smoke, and typecheck.
- Windows remote-access DAGPipe graph names owner surfaces, dependency arcs, success terminal, failure terminal, and cleanup terminal before product implementation begins.
- Packaged Windows app connects through the existing daemon protocol, renders a real mirror frame, sends a unique input marker, and automatically matches that marker in rendered DOM rows.
- Persistent sidebar, host/profile selection, session catalog projection, workspace split/tab projection, and status bar need source-to-DOM packaged evidence before remote-access client closure can be claimed.
- Ctrl+C / Windows console-control limitations are explicit until real console-control behavior is implemented and verified.
