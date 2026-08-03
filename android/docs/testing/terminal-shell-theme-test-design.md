# Terminal Shell Theme Test Design

## Scope

- Feature owner: `mainline_source.android` through module `client.app_shell`.
- Adjacent UI owner: `terminal.session_drawer` for drawer projection.
- Resources: `resource.platform_terminal_surface -> resource.ui_projection`.
- Forbidden paths: terminal payload, transport, daemon, tmux, buffer manager, and renderer truth.

## Lifecycle

```text
persisted terminalShellSkin
-> resolveEffectiveTerminalShellSkin
-> TerminalPage data-terminal-shell-skin
-> shared shell CSS variables
-> Header + QuickBar + Drawer + status/menu projection
```

The shell skin chooses presentation tokens. For the built-in/default renderer choice, `resolveTerminalRendererThemeForSkin` selects an established matching preset (`Pencil Light`, `Cobalt2`, or `Classic Dark`); any explicit non-default renderer theme remains renderer truth and is never rewritten.

The default light renderer uses the upstream iTerm2-Color-Schemes Pencil Light values (`#f1f1f1` background, `#424242` foreground, `#20bbfc` cursor) instead of an invented white/black pair. Quick input and file sheets consume the same panel tokens. Dark/blue buttons use the same raised highlight, inset shade, and outer shadow model as light buttons; light labels use a restrained engraved text shadow.

## Positive Gates

- Light, blue, and black skins expose complete shell surface/text/accent token sets.
- Header, QuickBar, drawer, route menu, and status strip inherit the same effective skin.
- Collapsed/floating QuickBar roots expose a transparent surface state; expanded roots consume the themed surface.
- Phone single/split terminal stages have zero left/right outer margin.
- Settings and connection-properties back intents still return to Home.

## Negative Gates

- Drawer and route/status surfaces do not retain hard-coded dark-blue shell colors in light or black mode.
- The themed QuickBar background does not override collapsed/floating transparency.
- Theme selection does not mutate terminal transport, session, daemon, buffer, or renderer state.
- Terminal system-back intent does not call `exitApp`; non-terminal Home exit behavior remains unchanged.
- Removing side gutters does not add padding or resize logic to `TerminalView`.

## Required Verification

- `src/lib/terminal-shell-skin.test.ts`
- `src/components/terminal/TerminalSessionDrawer.test.tsx`
- `src/hooks/useAppPageState.test.tsx`
- `src/pages/TerminalPageStageShell.pane-stage.test.tsx`
- `packages/shared/src/react/pane-profile.test.ts`
- `type-check`
- `test:feature-registry`
- Full Android build and packaged UI inspection.
