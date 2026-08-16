# Terminal Refresh Buffer Truth Test Design

## Objective

Lock `terminal.buffer_render` against stale or missing repaint rows during fast terminal refreshes.

The gate must automatically compare source buffer truth with the rendered target output. Manual visual confirmation is not enough.

## Lifecycle Path

```text
daemon buffer-sync body payload
-> unique wire normalization with frame identity preserved
-> client sparse buffer apply
-> session render gate projection
-> TerminalView visible rows
-> DOM row text / absolute row index
```

Mainline call ids:

- `android_mainline:StageShell->TerminalView`
- `android_mainline:TerminalView->Renderer`
- `android_mainline:Renderer->RenderGate`
- `android_mainline:SocketMessage->BufferWireNormalize`
- `android_mainline:BufferWireNormalize->BufferSyncIngress`
- `android_mainline:BufferSyncIngress->BufferFrameAssembly`
- `android_mainline:BufferFrameAssembly->BufferSparseApply`

Owner feature: `terminal.buffer_render`.

## White-Box Plan

- `session-context-buffer-runtime.test.ts` proves consecutive same-window `buffer-sync` updates mutate local buffer truth and schedule render commit.
- `session-context-buffer-runtime.test.ts` also proves a lower-revision `buffer-sync` cannot repaint older rows over newer rows, and that a late same-revision `buffer-sync` cannot overwrite existing non-gap absolute rows with older content, while same-revision gap repair can still fill local gaps.
- `session-render-gate.test.ts` and `session-render-gate.tui-content.test.ts` prove render snapshots are isolated but still reproject changed cell content at the same absolute row.
- `session-render-buffer-store.test.ts` proves the renderer publication boundary is monotonic: a lower-revision render snapshot cannot publish older rows over a newer render body, and a low revision is accepted again only after explicit `deleteSession()` resets that session render truth.
- `buffer-sync-contract.test.ts` proves daemon live diff `buffer-sync` payloads cover the complete authoritative changed span between the first and last changed range; it must not send non-adjacent rows with holes that make the client preserve stale middle rows.
- `terminal-mirror-runtime.backpressure.test.ts` proves an oversized changed-span body refresh is split into contiguous `buffer-sync` chunks that cover every source row in order; it must not fall back to a short live-tail payload that drops changed rows outside the tail.
- `terminal-mirror-capture.test.ts` proves daemon capture does not publish a transient half frame and does not let a live mirror tail anchor regress when tmux/TUI reports a shorter alternate-screen window.
- `mirror-line-canonicalizer.test.ts` proves ANSI foreground/background/attribute state emitted once by `tmux capture-pane -e` continues across physical soft-wrap rows until an explicit SGR reset; a reset on the preceding row must keep the next row at default rendition.
- `session-context-buffer-runtime.test.ts` and `TerminalView.dynamic-refresh.test.tsx` prove a missed non-gap visible row cannot be hidden by a later same-tail sparse revision advance; the client must request one authoritative visible-window body repaint from the buffer owner instead of treating global revision equality as row freshness.
- `session-context-buffer-runtime.test.ts` proves a sparse payload rejected across a revision gap schedules the current stable render immediately and requests the rejected payload's complete declared range. The repair must not depend on a later manual scroll to rediscover that range.
- Negative path: `buffer-head` / cursor metadata must not become a body repaint source.
- Negative rendition path: renderer/theme code cannot infer, remove, or repair missing row background. The daemon mirror canonicalizer is the unique owner that converts tmux capture bytes into per-cell rendition truth.
- Chunked-frame positive path: two or more chunks from one authoritative frame may arrive out of order, but the client buffer owner must publish exactly once after exact contiguous coverage is complete; local sparse truth and renderer truth remain on the previous complete frame before completion.
- Wire-normalization positive path: real socket dispatch preserves `frameStartIndex`, `frameEndIndex`, `frameChunkIndex`, `frameChunkCount`, and `generatedAt` before frame assembly. Malformed present frame fields remain explicitly invalid and cannot be normalized into an unchunked passthrough payload.
- Chunked-frame negative paths: a missing chunk, duplicate conflicting chunk, overlapping chunk window, internal absolute-row hole, lower-revision late chunk or unchunked payload, or same-revision different-frame interleave must not mutate local truth, advance local revision, discard the newer pending frame, or schedule a renderer commit.
- Resource-bound negative paths: a declared span over 4096 rows, more than 512 chunks, retained serialized payload over 64 MiB, or an incomplete frame older than 15 seconds must release retained chunk state and enter explicit frame error truth. Head cadence must expire idle incomplete frames and dispatch at most one exact-range repair; it must not require another body chunk to trigger cleanup.
- Same-revision repair path: rejecting a different frame identity must clear the poisoned incomplete assembly; the next authoritative repair with one consistent identity must then publish once, while the rejected interleave never becomes local/render truth.
- Explicit error path: every rejection remains in the independent per-session `resource.client_buffer_frame_assembly` as `BufferSyncError01InvalidFrame`; same-revision interleave repairs the original pending frame range rather than the incoming conflicting range. Repairable failures stay `pending` when the request cannot enter the wire, retry on the next legal head, and become `dispatched` only after one actual wire dispatch per revision. Invalid wire revision must never become a fabricated revision `0`: retain the pending frame revision when one exists, otherwise wait for an authoritative live-head revision. A bounded per-session `repairDispatchedRevisions` ledger survives later successful revisions, so a delayed malformed message cannot dispatch a second repair for an older revision; explicit session cleanup retires the ledger. When a newer frame supersedes an incomplete older frame, its pending state must atomically clear the older pending repair error while preserving the dispatch ledger. Non-repairable stale frames must not dispatch repair.
- Lifecycle path: tab switch, inactive body drop, socket generation cleanup, and reconnect may clear only the incomplete `pending` chunk state. They retain revision-reset expectation, frame error truth, and the bounded repair ledger for the same daemon revision epoch. The first authoritative lower daemon head starts a new revision epoch and atomically clears pending/error/ledger before any repair dispatch; repeated heads in that same reset epoch cannot clear a newly dispatched repair. Explicit local session destruction deletes both revision-reset and frame-assembly resources.
- Atomicity assertion: tests must inspect every intermediate commit/render observation, not only the final buffer. No observation may contain new middle/tail markers mixed with old markers from the previous frame.

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
  - source row changed or cleared once, the client missed that non-gap body row, then a later same-tail sparse patch arrives; output DOM must converge to source only through an authoritative visible-window repaint.
  - the first visible repair dispatch is lost or its response is incomplete; a later same-tail sparse patch must remain in a retryable ledger state and converge after a complete authoritative visible-window response, instead of being suppressed by a stale 5s cooldown.
  - a complete visible-window response clears the exact `visibleRange + tailEndIndex + targetRevision` ledger once, and unchanged visible rows do not emit repeated repair requests.
  - a fulfilled repair is only historical truth: a later sparse revision advance over the same visible window must create a new repair demand instead of being permanently suppressed by the old fulfilled entry.
  - lower-revision late payloads and same-revision late payload conflicts against non-gap rows must be explicit drops, not silent overwrites or UI clears.
  - oversized source frames split into multiple wire messages, with middle and tail markers in different chunks; DOM stays on the previous complete source frame until assembly completes, then changes once to the new complete source frame with no old marker flashback.
  - incomplete or invalid chunk sets never appear in DOM and do not hide the visible-range gap/repair demand behind a globally advanced revision.

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

## Close-Loop Intermediate Verification Modes

Every daemon mirror replay step must declare one mode:

- `source-only`: checks source/target semantics such as byte-exact long-input delivery; that intermediate instant is not asserted to be a published client render frame.
- `source-and-client-render`: checks a client-visible observation; any intermediate source/client mismatch fails the process even when the final frame later converges.

Unknown or missing modes fail. A final match cannot hide an earlier mixed client frame. The executable gate is `scripts/client-mirror-replay.ts`, covered by `src/server/daemon-mirror-lab-script.test.ts`.

Frame error-truth settlement is commit-gated:

- A structurally valid payload that is later rejected by sparse freshness rules must retain the existing exact repair range and dispatch ledger.
- A replacement that reaches sparse apply but is not accepted by `commitSessionBufferUpdate` must retain frame error truth.
- Only an accepted no-op or committed sparse-buffer replacement may clear frame error truth.
- Resource-limit rejection retains the validated authoritative frame range while marking repair `unavailable`; it must not dispatch an oversized repair request.

## Rust Migration Register

`terminal.buffer_render.frame_assembly.rust` is `planned`; the current active owner remains `src/lib/buffer-frame-assembly/session-buffer-frame-assembly.ts#assembleBufferSyncFrameChunk`. The target is `crates/zterm-terminal-core/src/buffer_frame_assembly.rs`. Activation requires TS/Rust parity, all white-box positive/negative cases above, source-to-DOM atomicity, bridge wiring, and physical removal of the TS policy owner. A planned entry is not active architecture truth.

`terminal.buffer_render.source_adapter.rust` is `planned`; the current active
owner remains `src/server/terminal-source-adapter.ts` plus the tmux/Herdr/
WezTerm adapter implementations. The target is a Rust source-adapter contract
with TS bridge, source-neutral snapshot serialization, adapter parity tests,
and physical removal of the TS adapter contract. A planned entry is not active
architecture truth.

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
- `daemon_mainline:Mirror->BufferPublisher`
- `daemon_mainline:BufferPublisher->TransportSend`
- `daemon_mainline:Capture->PerformanceTrace`
- `daemon_mainline:Mirror->PerformanceTrace`
- `daemon_mainline:TransportSend->PerformanceTrace`
- `android_mainline:SessionContext->SocketMessage`
- `android_mainline:SocketMessage->BufferWireNormalize`
- `android_mainline:BufferWireNormalize->BufferSyncIngress`
- `android_mainline:BufferSparseApply->RenderGate`
- `android_mainline:SocketMessage->PerformanceTrace`
- `android_mainline:BufferSparseApply->PerformanceTrace`
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
# 2026-08-12 performance repair gates

- `renderer_window` projection may pass an explicitly immutable projected snapshot to the render store after the gate has already performed equality/reuse checks. The store must not rescan the same rows/cells on that path.
- Positive: a changed projected snapshot publishes once and preserves row identity for reused rows.
- Negative: a stale/lower revision remains rejected; a mutable caller snapshot remains cloned/isolated unless the explicit immutable handoff option is used.
- `resource.debug_channel` performance trace storage must use bounded O(1) append/eviction behavior. Positive: newest records survive at the limit; negative: old records are evicted and metadata-only validation remains enforced.
