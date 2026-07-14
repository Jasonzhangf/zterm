# zterm Windows Spec

## Scope

Windows support starts with a production-selectable daemon backend powered by WezTerm mux. A standalone Windows desktop client is a later shell layer.

## Product Boundary

- `win/` owns the future Windows desktop shell: window lifecycle, menus, packaging, platform integration, and Windows-specific smoke evidence.
- `android/src/server/wezterm-backend.ts` owns the Windows WezTerm daemon backend contract.
- Shared pane/layout/rendering behavior must come from existing shared/Mac app-layer code. `win/` must not copy terminal runtime, daemon mirror, buffer protocol, or renderer logic.

## Alpha Acceptance

- Windows daemon backend passes local unit tests, mock protocol smoke, real Windows remote smoke, real input smoke, and typecheck.
- Windows shell registry, resource binding, function map, lifecycle manifest, and test design name owner surfaces before implementation begins.
- Packaged Windows app connects through the existing daemon protocol, renders a real mirror frame, sends a unique input marker, and automatically matches that marker in rendered DOM rows.
- Ctrl+C / Windows console-control limitations are explicit until real console-control behavior is implemented and verified.
