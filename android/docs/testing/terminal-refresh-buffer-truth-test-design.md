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
- `session-context-buffer-runtime.test.ts` also proves a lower-revision `buffer-sync` cannot repaint older rows over newer rows, and that a late same-revision `buffer-sync` cannot overwrite existing non-gap absolute rows with older content, while same-revision gap repair can still fill local gaps.
- `session-render-gate.test.ts` and `session-render-gate.tui-content.test.ts` prove render snapshots are isolated but still reproject changed cell content at the same absolute row.
- `session-render-buffer-store.test.ts` proves the renderer publication boundary is monotonic: a lower-revision render snapshot cannot publish older rows over a newer render body, and a low revision is accepted again only after explicit `deleteSession()` resets that session render truth.
- `buffer-sync-contract.test.ts` proves daemon live diff `buffer-sync` payloads cover the complete authoritative changed span between the first and last changed range; it must not send non-adjacent rows with holes that make the client preserve stale middle rows.
- `terminal-mirror-runtime.backpressure.test.ts` proves an oversized changed-span body refresh is split into contiguous `buffer-sync` chunks that cover every source row in order; it must not fall back to a short live-tail payload that drops changed rows outside the tail.
- `terminal-mirror-capture.test.ts` proves daemon capture does not publish a transient half frame and does not let a live mirror tail anchor regress when tmux/TUI reports a shorter alternate-screen window.
- Negative path: `buffer-head` / cursor metadata must not become a body repaint source.

## Module Black-Box Plan

- `TerminalView.dynamic-refresh.test.tsx` renders controlled source buffers, then compares every visible DOM row by `data-terminal-index` against the final source buffer.
- Daemon capture black-box cases replay rapid TUI refresh shapes where one capture is a mixed frame and the next two captures are stable; the published mirror must equal the stable source, not the first transient source.
- The black-box cases must cover:
  - many rows updating inside the same `[startIndex,endIndex)` window,
  - oversized body refreshes where serialized bytes exceed the per-message budget,
  - fast TUI-like top/status/footer refresh,
  - alternate-screen tail anchor monotonicity when the visible pane has fewer authoritative rows than the existing mirror tail,
  - bottom row changing while the viewport stays in follow mode,
  - head-only metadata interleaved with body updates without repainting stale body text.
  - lower-revision late payloads and same-revision late payload conflicts against non-gap rows must be explicit drops, not silent overwrites or UI clears.

## Project Black-Box Impact

- This local gate simulates the Android field symptom before device work: source truth changes quickly, but output target must not retain stale rows.
- If a device shows old/new pages alternating during refresh, first inspect whether lower-revision payloads or same-revision late payloads are overwriting non-gap local truth. Do not clear the buffer or DOM as a workaround.
- If lower/same revision payloads are already rejected but the device still alternates, inspect `session.render-store.revision-regression-drop` and `session.render-gate.flush.inspect`. A render-store regression means renderer publication order is wrong; a high revision with old visible text means daemon mirror/diff source truth is wrong.
- If high-revision payloads alternate old/new visible text, first inspect whether daemon live diff sent disjoint changed rows inside one `[startIndex,endIndex)` payload. That payload shape is invalid for the current client sparse apply contract unless every row in the span is included.
- It does not replace L5 APK / real WebView smoke. If a device still leaks rows after this gate passes, the next suspect is WebView compositing or daemon payload order, not this local DOM projection alone.

## Known Gaps

- No real APK/WebView screenshot comparison yet.
- No live tmux `top` / `vim` run in this local unit gate.
- Daemon/tmux oracle comparison remains covered by `daemon:mirror:close-loop`; this design adds the Android client source-to-target DOM gate.

## 2026-07-13 Performance Lifecycle Extension

This extension locks the complete performance lifecycle without changing terminal payload semantics:

```text
tmux authoritative capture
-> canonicalize
-> mirror revision commit
-> physical body-subscription eligibility
-> subscriber send/backpressure
-> client receive
-> sparse buffer apply
-> next RAF
-> render commit
```

Mainline call ids:

- `daemon_mainline:Mirror->Capture`
- `daemon_mainline:Mirror->TransportSend`
- `daemon_mainline:Capture->PerformanceTrace`
- `daemon_mainline:Mirror->PerformanceTrace`
- `daemon_mainline:TransportSend->PerformanceTrace`
- `android_mainline:SessionContext->SocketMessage`
- `android_mainline:SocketMessage->BufferApply`
- `android_mainline:BufferApply->RenderGate`
- `android_mainline:SocketMessage->PerformanceTrace`
- `android_mainline:BufferApply->PerformanceTrace`
- `android_mainline:RenderGate->PerformanceTrace`

Trace edges move from `binding pending` to `anchored` only after the production owner emits current-version metadata and `/debug/runtime.performanceTrace` proves capture/send/rx/apply/render correlation without terminal payload.

### Trace White-Box Gates

Positive:

- A bounded trace store correlates repeated samples by `traceId + mirrorRevision + subscriberId`, not only by session.
- Repeated completed samples produce p50/p95/p99 for capture, canonicalize, send, send-to-rx, apply, RAF wait, render commit, capture-to-render, bytes, line count, and range count.
- A trace sample can be incomplete/still-running without being counted as a completed latency sample.
- Ring-buffer eviction removes old records without corrupting newer sample correlation.

Negative:

- Records containing `payload`, `text`, `lines`, `cells`, `content`, `data`, command text, token values, or file content are rejected.
- Events with the same session but different revision/trace id cannot be merged into one synthetic latency.
- A terminal error sample cannot be summarized as successful completion.
- `/debug/runtime` exposes only bounded metadata summaries and cannot serialize retained terminal rows.

### Physical Body Subscription Gates

Positive:

- Visible pane and bootstrap demand send one versioned physical body-subscription intent.
- `bodySubscribed=true` subscriber receives unsolicited live `buffer-sync`.
- `bodySubscribed=false` subscriber keeps its physical transport and mirror attachment but receives zero unsolicited body bytes.
- A mirror with only ready but body-unsubscribed subscribers stops recurring capture and clears its live timer.
- Resubscribe restores body eligibility, then current head and visible/tail repair reach the latest mirror revision.
- Resubscribe sends current head and returns to the unique mirror scheduler owner with immediate live demand.
- Multiple visible panes subscribe independently.

Negative:

- Unsubscribe cannot close transport, detach subscriber, destroy mirror, clear client buffer, or alter open tabs.
- Daemon subscriber state cannot contain active, inactive, foreground, pane visibility, follow, reading, viewport, or width-mode reasons.
- Subscription, `buffer-head-request`, and `buffer-sync-request` cannot call tmux capture.
- Explicit head/range reads remain available while body-unsubscribed and cannot restart recurring capture.
- Malformed or unsupported subscription version fails explicitly; there is no hidden old-client default body path.

### Subscriber Backpressure Gates

Positive:

- Healthy subscriber sends immediately and advances `lastSentRevision` only after successful send.
- Slow subscriber retains at most one pending latest revision plus merged absolute ranges.
- Crossing below low water flushes one latest-authoritative payload built from the current mirror store.
- Healthy and slow subscribers attached to one mirror prove the slow subscriber does not reduce healthy cadence.
- After output stops, slow subscriber reaches daemon latest revision within `max(1000ms, 2 * measured RTT)`.

Negative:

- Pending state cannot grow by revision count or retain serialized terminal payload/cells.
- Send throw, non-open transport, or stale drain generation cannot clear pending or advance sent revision.
- High/low water must use hysteresis; oscillation around one threshold cannot create an unbounded resend loop.
- Pending range/span/age overflow must enter explicit resync-required truth, never silent drop.
- Without an explicit client ACK, daemon state must be named sent/enqueued revision, not delivered revision.

### Hot-Tail / Full-Reconciliation Oracle Gates

Positive:

- Hot capture covers at least the complete mutable pane and computes absolute indexes only from tmux structural facts.
- A continuous authoritative range patch plus retained confirmed prefix produces the same complete mirror as full tmux oracle capture.
- Cache-tail advancement may remove expired prefix only when the remaining absolute window is provably continuous.
- Full reconciliation remains one capture, one canonicalization, and one authoritative commit through the same writer.

Negative:

- Content overlap or repeated text cannot determine an anchor.
- `cols`/reflow, rows change requiring unknown prefix, pane identity change, alternate transition, history shrink/clear, absolute discontinuity, structural instability, or periodic reconciliation expiry must reject range patch and enter full reconciliation.
- The writer cannot hide source-end regression with client state or renderer state.
- Head/range reads cannot become a reconciliation trigger.

### Send Accounting, RTT, And Renderer Gates

Positive:

- Structured send and pre-serialized `sendText` share bytes, total bytes, last success/error, buffered-before/after, duration, and backpressure transition accounting without re-stringifying.
- Real ping/pong or correlated request/reply produces RTT EWMA, jitter EWMA, progress age, and stall count for producer cadence.
- Body receive schedules render for the next RAF and reads the latest live buffer at flush.
- Renderer dirty-row optimization is implemented only if current-version trace crosses the plan threshold.

Negative:

- Network quality cannot add a renderer debounce after body arrival.
- Debug/trace construction cannot clone or stringify terminal rows.
- RTT/cadence cannot trim real payload or change string-only input.
- If renderer threshold is not crossed, no speculative second projection path is allowed.

### Module And Project Black-Box Matrix

- Daemon module: real mirror with two subscribers, controlled buffered amount, drain, send failure, detach/rebind generation, and exact final revision.
- Client module: socket receive -> sparse apply -> render gate with repeated correlated revisions and visible multi-pane demand.
- Contract module: physical subscription version/parser and conditional Buffer Sync V2 negotiation. V2 tests are added only if the measured hard threshold is crossed.
- Byte proxy module: transparent TCP forwarding preserves exact request/response bytes while enforcing one-way latency, deterministic jitter, byte-per-second caps, periodic stalls, and explicit disconnect windows. The proxy never parses WebSocket frames or terminal payload.
- Performance probe module: real control/session WebSocket handshakes create two physical subscribers on one mirror, toggle versioned body subscription, count actual wire bytes/message types/revisions, and prove final daemon/client revision without importing daemon internals.
- L2 real tmux: `top`, `vim`, high-rate single-line output, history growth, clear-history, resize/reflow, and alternate screen against oracle.
- L3/L4: Android transport/buffer/render/pane gates and Mac shared transport/runtime gates.
- L5: unlocked foreground Android app through byte-forwarding proxy profiles for good, 256 Kbps + 300ms RTT + jitter, periodic stall, and explicit disconnect/reconnect.

### Current Evidence Gaps

- Production trace production owners and raw client-rx byte binding are implemented in source and focused gates; current-version daemon `/debug/runtime.performanceTrace` proof is still missing.
- Physical body-subscription wire contract, daemon subscriber truth, client intent, and scheduler-demand gates exist; real inactive-byte reduction and resubscribe replay through the weak-network harness remain missing.
- Subscriber pending-latest/drain state and focused gates exist; healthy+slow real two-subscriber drain proof remains missing.
- Hot-tail structural fingerprint and authoritative range-patch tests do not exist yet.
- `scripts/weak-network-byte-proxy.ts` and `scripts/terminal-performance-probe.ts` must replace the existing log-only weak-network scripts as the real byte-shaping and protocol-measurement gate. Completion requires byte-equivalence tests plus current daemon good/narrow/stall/disconnect evidence.
- Current daemon logs predate final worktree code and cannot satisfy L2-L5 acceptance.
