# Module And Edge Registry Test Design

Date: 2026-07-26

## Goal

Lock project-wide module boundaries before the next runtime refactor. This layer sits between global resources and feature-local function maps:

```text
resource registry -> module registry -> edge registry -> function map -> mainline call map -> runtime code
```

## Lifecycle Paths

| lifecycle | positive path | negative path |
| --- | --- | --- |
| Daemon target connection | `client.session_runtime -> client.daemon_connection -> client.terminal_channel_mux -> daemon.transport_subscriber` | UI, drawer, picker, remote-window catalog, or file transfer opens a separate socket. |
| Terminal body render | `daemon.mirror_store -> daemon.transport_subscriber -> client.buffer_frame_assembly -> client.sparse_buffer -> client.renderer_window -> client.app_shell` | Renderer reads tmux/mirror directly, buffer store duplicates sparse body truth, or transport writes client sparse buffer without channel demux. |
| Remote-window control | `client.app_shell -> client.remote_window_overlay -> remote_window_touch_action -> daemon.remote_window_stream` | Overlay claims input success without action dispatch evidence, or daemon stream uses terminal mirror rows as video/control truth. |
| Relay resume | `relay.peer_lease -> transport_target -> daemon_target_transport` | Relay stores terminal channel, subscriber, tmux, mirror, active tab, foreground, viewport, or UI truth. |
| Release/start | `release_update_artifact -> daemon_runtime_artifact -> daemon_process` | Runtime executes authoring source or release artifact starts daemon process directly. |
| Observability | `daemon_process -> debug_channel` | Debug snapshot or trace becomes business payload/truth. |

## White-Box Gates

- `src/lib/module-registry-truth.test.ts`
  - registry JSON is parseable.
  - module ids are unique and follow side-qualified naming.
  - parent module ids exist.
  - owner features exist.
  - owned/consumed/forbidden/pending resources exist in `docs/resource-registry.json`; active owned/consumed resources must have `status: active`; design/pending resources are tracked only through `pending_resources` in `docs/module-registry.json`.
  - one concrete resource has at most one owning module.
  - canonical docs and file-like required gates exist.
  - every module forbidden resource is not also owned by the same module.
- `src/lib/edge-registry-truth.test.ts`
  - edge ids are unique.
  - edge modules and resources exist.
  - owner features exist.
  - `direct` edges exist in resource registry direct relations.
  - `via` edges declare via resources.
  - forbidden resource direct relations are not declared as direct.
  - `mainline_call_ids` exist in `docs/wiki/mainline-call-map.json`.
  - request/response/error chains are non-empty and use numbered node names.
  - every edge gate exists when it is a file path.
- `src/lib/module-import-graph-truth.test.ts` (code-vs-registry gate; the gates above only prove the registries are self-consistent)
  - every `owned_paths` pattern in `docs/module-registry.json` resolves to a real file or directory.
  - every non-test source file under `src/` is owned by exactly one module through `owned_paths`; unowned and multi-owned files are red.
  - every active edge connects two active modules; an active runtime edge pointing at a `design` or `pending` module is red.
  - the real cross-module import graph (parsed from source `import`/`export from`/`require`) matches `docs/edge-registry.json` `import_edges` in both directions: an import edge in code that is not declared is red; a declared entry with no import left in code is red (stale entries must be removed).
  - `pending_removal` entries are known violations: each needs a removal note, and the count may only go down (currently 1: `observability.debug_channel -> client.daemon_connection`).

## Module Black-Box Gates

- Connection module gate:
  - same daemon target opens one physical connection.
  - session switch opens/resumes only terminal channels, not a new physical socket.
  - drawer/session-picker/remote-window catalog use the same daemon connection interface.
- Buffer/render gate:
  - `daemon.mirror_writer` owns validated capture and authoritative snapshot commit writes; `daemon.mirror_store` owns canonical mirror revision and runtime scheduling and does not re-own capture.
  - mirror patch reaches sparse buffer only through channel/subscriber path.
  - renderer visible range remains the only visible-window truth.
  - body repaint never comes from head metadata alone.
- Remote-window gate:
  - user touch becomes one action record before daemon input.
  - stale action older than one second is dropped explicitly.
  - screenshot request does not focus/raise target app.
- Relay gate:
  - lease keyed by concrete client device.
  - lease cannot expose terminal channel/subscriber/mirror/session business truth.
- Release gate:
  - daemon start consumes deterministic staged artifact only.
  - update artifact cannot directly start daemon process.

## Project Black-Box Gates

Docs/static:

```bash
pnpm --dir android exec vitest run \
  src/lib/module-registry-truth.test.ts \
  src/lib/edge-registry-truth.test.ts \
  src/lib/resource-registry-truth.test.ts \
  src/lib/function-map-resource-truth.test.ts \
  src/lib/mainline-resource-call-map.test.ts \
  --reporter dot
```

Feature registry:

```bash
pnpm --dir android run test:feature-registry -- --reporter dot
```

Runtime refactor later:

- `terminal.transport_lifecycle`: run mapped transport/session/mux tests and live reconnect matrix.
- `terminal.buffer_render`: run tmux oracle -> daemon -> client sparse -> renderer DOM black-box gate.
- `desktop.remote_window_stream`: run daemon app-window catalog/cache, stream, input, screenshot, and installed-phone action replay gates.

## Known Gaps

- This gate locks architecture manifests and docs. It does not prove live client/daemon behavior.
- Runtime use of `pending_resources` is not allowed. Future resources may be listed in module `pending_resources` only while their resource-registry status is `design` or `pending`; before code uses them, the resource must become `active`, move into module owned/consumed resources, and connect through `docs/edge-registry.json`.
- Existing mainline call ids are reused only where code already exists. New runtime edges must first land in `docs/edge-registry.json`, then in the mainline call map with real caller/callee bindings.
