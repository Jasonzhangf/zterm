# Fix Design Report: Herdr Preview Color Rendering

Design ID: `FD-20260814-HERDR-PREVIEW-COLOR-01`

Status: `WAITING_FOR_JASON_APPROVAL`

Date: 2026-08-14

## 1. Symptom

Herdr `hd-codex` diff summaries show ANSI red/green `(+N -N)` deltas as gray.
The daemon wire and the non-preview renderer path are already proven correct.

## 2. Root Cause And Owner

The first divergence is the passive secondary preview projection in
`TerminalView.tsx`:

```tsx
{passivePreviewProjection
  ? renderRowsWithSignatures.map(({ row }) => {
      const plainText = terminalRowToText(row);
      return (
        <div style={{ color: theme.foreground, ... }}>
          {plainText || "\u00a0"}
        </div>
      );
    })
  : <VisibleRow ... />}
```

It deliberately flattens each row to one plain-text DOM node. That is the only
client path that removes per-cell `fg` from the DOM. The buffer still contains
`fg=1` / `fg=2`, and the same buffer renders red/green through `VisibleRow`.

Owner:

- Feature: `terminal.session_preview` / `terminal.buffer_render`
- Module: `client.session_drawer_preview` + `client.renderer_window`
- Function: `terminal.session_preview.grid.render`
- Allowed files: `src/components/TerminalView.tsx` (passive preview branch),
  new `src/components/terminal/TerminalPreviewRow.tsx`, its tests,
  `src/components/terminal/TerminalPreviewGrid.tsx` only if needed for test
  wiring, function map / feature registry / test design docs.
- Forbidden: daemon Herdr canonicalizer, mirror wire, sparse buffer,
  transport, preview selection/order, primary preview semantics, or main
  terminal `VisibleRow` behavior.

## 3. Formal Fix

1. Reuse the existing shared row renderer instead of duplicating color logic.
   `buildTerminalVisibleRowViewModel()` / `renderRowCells()` already map every
   cell through `terminalCellStyle()` with the selected theme.
2. Add a lightweight `TerminalPreviewRow` component under
   `src/components/terminal/` that renders one row node plus per-cell spans
   from that shared view model.
3. Replace the plain-text passive branch in `TerminalView.tsx` with
   `TerminalPreviewRow`, keeping:
   - `data-terminal-preview-row="true"` and row-index/gap attributes;
   - `data-terminal-row-text` as the plain text projection;
   - no cursor, no input, no resize, no viewport demand;
   - passive tail-follow behavior unchanged.
4. Preserve `terminalRowToText()` for data attributes and copy semantics; it is
   no longer the visual body truth.
5. Update `function-map.md`, `feature-registry.json`, and
   `docs/testing/terminal-session-preview-test-design.md` so the secondary
   preview contract is "one row DOM node with per-cell theme spans", not "one
   plain text DOM node".

## 4. Test Design

Red/green:

- Red: secondary preview with `fg=2` / `fg=1` cells must render non-gray ANSI
  colors; current code renders `theme.foreground`.
- Green: primary preview and main terminal render the same row identically
  through the shared color resolver.
- Green: neutral/default cells still use theme foreground; saturated red/green
  are not neutral-contrast-projected to gray.
- Green: passive preview still emits no input/resize/viewport callbacks and
  still follows the latest tail.
- Green: Herdr wire fixtures retain `fg=1` / `fg=2`.

Existing gates:

- `test:feature-registry`
- focused `TerminalPreviewGrid` / `TerminalView` tests
- `tsc --noEmit`
- full Android build / install only after local gates pass
- online device CDP/computed-style verification when the device is reachable

## 5. Non-Goals

- No Herdr source or canonicalizer change.
- No wire protocol or buffer truth change.
- No reconnect/background/transport change.
- No change to primary preview or main terminal rendering semantics.

## 6. Live Verification

1. Run the focused DOM gate from
   `playground/herdr-color-render-20260814/preview-color-dom.test.tsx`.
2. Reinstall APK when available and open Herdr `hd-codex`.
3. Find the secondary preview row that contains `(+N -N)` and verify computed
   color is `rgb(106, 153, 85)` / `rgb(244, 71, 71)` under `classic-dark`.
4. Verify the primary preview and full terminal remain unchanged.
