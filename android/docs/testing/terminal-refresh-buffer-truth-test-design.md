# Terminal Refresh Buffer Truth Test Design

## Objective

Lock `terminal.buffer_render` against stale or missing repaint rows during fast terminal refreshes.

The gate must automatically compare source buffer truth with the rendered target output. Manual visual confirmation is not enough.

## Lifecycle Path

```text
daemon buffer-sync body payload
-> client sparse buffer apply
-> session render gate projection
-> TerminalView visible rows
-> DOM row text / absolute row index
```

Mainline call ids:

- `android_mainline:TerminalPage->TerminalView`
- `android_mainline:TerminalView->Renderer`
- `android_mainline:Renderer->RenderGate`

Owner feature: `terminal.buffer_render`.

## White-Box Plan

- `session-context-buffer-runtime.test.ts` proves consecutive same-window `buffer-sync` updates mutate local buffer truth and schedule render commit.
- `session-render-gate.test.ts` and `session-render-gate.tui-content.test.ts` prove render snapshots are isolated but still reproject changed cell content at the same absolute row.
- `terminal-mirror-capture.test.ts` proves daemon capture does not publish a transient half frame and does not let a live mirror tail anchor regress when tmux/TUI reports a shorter alternate-screen window.
- Negative path: `buffer-head` / cursor metadata must not become a body repaint source.

## Module Black-Box Plan

- `TerminalView.dynamic-refresh.test.tsx` renders controlled source buffers, then compares every visible DOM row by `data-terminal-index` against the final source buffer.
- Daemon capture black-box cases replay rapid TUI refresh shapes where one capture is a mixed frame and the next two captures are stable; the published mirror must equal the stable source, not the first transient source.
- The black-box cases must cover:
  - many rows updating inside the same `[startIndex,endIndex)` window,
  - fast TUI-like top/status/footer refresh,
  - alternate-screen tail anchor monotonicity when the visible pane has fewer authoritative rows than the existing mirror tail,
  - bottom row changing while the viewport stays in follow mode,
  - head-only metadata interleaved with body updates without repainting stale body text.

## Project Black-Box Impact

- This local gate simulates the Android field symptom before device work: source truth changes quickly, but output target must not retain stale rows.
- It does not replace L5 APK / real WebView smoke. If a device still leaks rows after this gate passes, the next suspect is WebView compositing or daemon payload order, not this local DOM projection alone.

## Known Gaps

- No real APK/WebView screenshot comparison yet.
- No live tmux `top` / `vim` run in this local unit gate.
- Daemon/tmux oracle comparison remains covered by `daemon:mirror:close-loop`; this design adds the Android client source-to-target DOM gate.
