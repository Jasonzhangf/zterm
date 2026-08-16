# Herdr History Tail + Live Latency Truth

Design IDs: `FD-20260814-HERDR-HISTORY-SHORT-01`,
`FD-20260814-HERDR-UPDATE-LATENCY-01`

Date: 2026-08-14

Owner: `daemon.herdr_backend` / `daemon.mirror_runtime`

## Contract

- Herdr adapter owns a daemon-side history tail snapshot built from:
  `pane read <paneId> --source recent --lines <min(terminalCacheLines,1000)>
  --format ansi --raw`.
- `HerdrFrameCanonicalizer` remains the live frame owner for visible rows,
  cursor, geometry, cursorKeysApp, alternate screen, and attachment
  validation. It is not the mirror history owner.
- `pane get.scroll` values `maxOffsetFromBottom + viewportRows` are the only
  allowed source total-row hint. They advance the daemon-owned monotonic
  `sourceEndIndex`; they never define absolute line identity.
- `bufferStartIndex = sourceEndIndex - bufferLines.length`;
  `availableStartIndex = bufferStartIndex`. Earlier history is not fabricated.
- Host at bottom plus matching geometry is the only condition for overlaying
  canonical live visible rows onto the history tail. Host scrolled => no
  overlay and cursor is null.
- History refresh is low-frequency (default 1000ms) with immediate refresh on
  attach, host scroll change, and geometry change. The 1000-line read never
  enters the 33ms capture loop.
- Live tail overlays may advance the daemon-owned `sourceEndIndex` from a
  fresh authoritative total only when the growth is representable inside the
  current history window and visible frame; otherwise the overlay is
  suppressed until the next history read. This prevents publishing stale
  absolute indices or gapped rows between history refreshes.
- Live canonical frames call `onLiveActivity` so server wiring can call
  `scheduleMirrorLiveSync(mirror, 0)`. No body subscriber means no timer.
- `pane get` scroll metrics are throttled (default 100ms) and a metrics read
  failure must not drop the authoritative frame. Cached metrics are never used
  to advance `sourceEndIndex`. A daemon-confirmed bottom scroll state may
  authorize in-place live-row overlay for intervening frames between fresh
  `pane get` reads; those overlays never advance the absolute window.
- Immediate history refresh fires only when the confirmed host scroll state or
  geometry transitions. Repeated metrics-bearing frames while the host stays
  scrolled use the normal 1000ms history cadence instead of starting a full
  `pane read` per sample.
- History refreshes require a fresh `pane get` total for that refresh. Cached
  scroll metrics never advance `sourceEndIndex` for a new `pane read`; if the
  fresh read fails, the refresh is rejected and the existing history window
  remains published.
- After a history read's canonicalization await, the adapter rechecks the
  latest canonical frame geometry. If geometry changed, the read is retried
  against the latest geometry; if it cannot stabilize, the refresh is
  rejected. Stale-width rows are never published under newer `cols`/`rows`.
- `pane read` failure or empty output is an explicit adapter error. Frame-only
  fallback is forbidden.
- Herdr 0.8.0 caps recent history at 1000 lines. zterm publishes the explicit
  capability gap `herdr-history-limit-1000`.

## Architecture Boundary

The history/live merge lives inside `daemon.herdr_backend`. Mirror store keeps
consuming one `TerminalSourceMirrorSnapshot` from `readSnapshot()`; no new
client, renderer, tmux, or WezTerm path is introduced.
