# Terminal Shell Theme Test Design

## Scope

- Feature owners: `mainline_source.android` through module `client.app_shell`, plus `terminal.buffer_render` through module `client.renderer_window` for final cell-color projection.
- Adjacent UI owner: `terminal.session_drawer` for drawer projection.
- Resources: `resource.platform_terminal_surface -> resource.ui_projection`; `resource.client_sparse_buffer -> resource.renderer_window` for read-only cell projection.
- Forbidden paths: terminal payload mutation, transport, daemon, tmux, buffer manager, and shell-side repair of cell colors.

## Lifecycle

```text
persisted terminalShellSkin
-> resolveEffectiveTerminalShellSkin
-> TerminalPage data-terminal-shell-skin
-> shared shell CSS variables
-> Header + QuickBar + Drawer + status/menu projection
```

The shell skin chooses presentation tokens. For the built-in/default renderer choice, `resolveTerminalRendererThemeForSkin` selects an established matching preset (`Pencil Light`, `Cobalt2`, or `Classic Dark`); any explicit non-default renderer theme remains renderer truth and is never rewritten.

The default light renderer uses the upstream iTerm2-Color-Schemes Pencil Light values (`#f1f1f1` background, `#424242` foreground, `#20bbfc` cursor) instead of an invented white/black pair. Quick input and file sheets consume the same panel tokens. Every skin supplies its own raised button surface, edge highlight, inset shade, and outer shadow. Labels use one restrained skin-specific engraving shadow; opposing duplicate shadows are forbidden because they render as doubled glyphs on high-density Android screens.

`resolveTerminalCellColors` is the sole projection owner for ANSI/truecolor foreground contrast. Neutral foregrounds that are too close to the effective cell background move only far enough toward the theme foreground to meet WCAG contrast; colored foregrounds with adequate contrast remain exact. `dim` keeps a weaker visual hierarchy but must retain a readable contrast floor instead of always blending 50% into the background.

## Positive Gates

- Light, blue, and black skins expose complete shell surface/text/accent token sets.
- Header, QuickBar, drawer, route menu, and status strip inherit the same effective skin.
- Collapsed/floating QuickBar roots expose a transparent surface state; expanded roots consume the themed surface.
- Phone single/split terminal stages have zero left/right outer margin.
- Settings and connection-properties back intents still return to Home.
- Light-background white/light-gray foregrounds and dark-background black/dark-gray foregrounds meet the renderer contrast floor.
- Dim text remains visibly weaker than normal text while staying readable on both light and dark renderer backgrounds.
- Black-skin QuickBar buttons retain visible raised edges against the black panel, and all button labels use one engraving shadow without duplicate glyph edges.

## Negative Gates

- Drawer and route/status surfaces do not retain hard-coded dark-blue shell colors in light or black mode.
- The themed QuickBar background does not override collapsed/floating transparency.
- Theme selection does not mutate terminal transport, session, daemon, buffer, or renderer state.
- Terminal system-back intent does not call `exitApp`; non-terminal Home exit behavior remains unchanged.
- Removing side gutters does not add padding or resize logic to `TerminalView`.
- Saturated ANSI colors, sufficient-contrast truecolor pairs, reverse video, explicit backgrounds, and stored cell payloads are not rewritten.
- QuickBar labels do not use simultaneous light/dark offset shadows, and black-skin depth does not depend on an outer black shadow alone.

## Required Verification

- `src/lib/terminal-shell-skin.test.ts`
- `src/components/terminal/TerminalSessionDrawer.test.tsx`
- `src/hooks/useAppPageState.test.tsx`
- `src/pages/TerminalPageStageShell.pane-stage.test.tsx`
- `packages/shared/src/terminal/cell-render.test.ts`
- `packages/shared/src/react/pane-profile.test.ts`
- `type-check`
- `test:feature-registry`
- Full Android build and packaged UI inspection.
