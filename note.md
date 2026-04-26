## 2026-04-21 Mac shell workspace implementation
- Goal: replace static preview with real shell workspace (single pane by default, vertical split on demand, pane tabs, no persistent sidebars, blue-gray)
- Truth: keep runtime honest; first slice only active pane/tab drives live bridge session
- Success: type-check + package pass + packaged app visual smoke

## 2026-04-25 Android client refresh initialization audit
- Symptom: active tab may stay `connecting`, blank, low/0Hz refresh until input/focus side effects.
- Hypothesis 1: initialization still depended too hard on `connected`; if first live frame arrives before/without clean `connected`, client can self-block.
- Hypothesis 2: active head tick and active-tab initialization still gate on `session.state === connected`, so a tab stuck in `connecting` never keeps polling head and never self-heals.
- Decision: keep daemon pull-only; fix client initialization only at three points: 1) accept live `buffer-head`/`buffer-sync` as connected establishment signal; 2) active head tick must continue while `connecting|reconnecting`; 3) active tab switch/initialization must request head immediately instead of scheduling unrelated reading repair.
- Success evidence: targeted vitest covers `buffer-head` establishment + `connecting` state keeps polling head; type-check passes.

## 2026-04-25 transport truth trim
- Removed wrong transport-active model: client no longer treats recently viewed tabs as 33ms active; only the current active session keeps high-frequency head polling.
- Removed dead transport side-path: client/server now only use `buffer-head` + explicit range request for terminal sync.
- Tightened input refresh: only reading->follow transition forces head refresh; burst input no longer bypasses the head throttle.

## 2026-04-25 terminal role freeze
- Server only mirrors tmux truth and answers `head` + requested `ranges`.
- Server must not carry strategy/render semantics: no follow/reading state, no patch planning, no render-driven behavior.
- Multi-session means multiple parallel canonical buffers; server does not infer client intent across sessions.
- Client buffer worker only polls head and requests explicit buffer ranges.
- Renderer only owns follow/reading + `renderBottomIndex`, and only consumes buffer.
