# Resource Truth Test Design

Date: 2026-07-12

## Goal

Lock global resource ownership before code refactor. The first phase proves resource ids, owners, relations, mainline edges, and function map bindings are reviewable and enforceable.

## Lifecycle Paths

| lifecycle | positive path | negative path |
| --- | --- | --- |
| Session switch/input/reconnect/bootstrap | `open_tab -> active_session -> session_transport -> transport_subscriber -> mirror_store -> client_sparse_buffer -> renderer_window -> ui_projection` | UI directly opens sockets, input bypasses transport owner, retryable intermediate failure becomes terminal error, first bootstrap lacks head/body resource sync. |
| Daemon backend/mirror/input | `daemon_process -> terminal_backend -> backend_session -> tmux_session/wezterm_pane -> mirror_store` and `daemon_input_queue -> backend_session` | Daemon stores client active/viewport/follow truth; mirror self-writes geometry/content from requested layout; input writes directly to backend without queue owner. |
| CLI/release/debug | `release_update_artifact -> daemon_runtime_artifact -> daemon_process` and debug channel observes only | Runtime scans authoring directories as truth; debug/log/snapshot metadata becomes business payload truth. |

## White-Box Gates

- `src/lib/resource-registry-truth.test.ts`
  - registry is parseable.
  - every `resource_id` is unique.
  - every `owner_feature` exists in `docs/feature-registry.json`.
  - every relation id exists.
  - forbidden direct relation is not declared as direct relation.
  - canonical docs and local gate files exist when they are file paths.
- `src/lib/function-map-resource-truth.test.ts`
  - function map has a resource binding section.
  - every binding uses declared resource ids.
  - critical global feature ids bind to resource ids.
  - function map does not invent `resource.*` ids outside the registry.
- `src/lib/mainline-resource-call-map.test.ts`
  - every call-map edge has `resource_from`, `resource_to`, `via_resources`, and `relation_status`.
  - edge resources exist.
  - direct edges must exist in the registry unless marked `via`.
  - forbidden direct edges fail.

## Module Black-Box Gates

- Transport resource store tests for `session_transport`, `transport_target`, and `pending_open_intent`.
- Input resource tests for `platform_input_channel -> session_transport -> daemon_input_queue`.
- Session switch/open-intent tests for single-flight `{sessionId,targetKey,openRequestId}`.
- Backend selection resource tests for `terminal_backend -> backend_session`.
- Mirror capture owner tests proving backend capture is the only owner of mirror content/geometry.
- Runtime artifact promotion tests proving `release_update_artifact -> daemon_runtime_artifact -> daemon_process`.

## Project Black-Box Gates

- `pnpm --dir android run test:feature-registry -- --reporter dot`.
- `pnpm --dir android exec vitest run src/lib/resource-registry-truth.test.ts src/lib/function-map-resource-truth.test.ts src/lib/mainline-resource-call-map.test.ts -- --reporter dot`.
- If implementation touches daemon/mirror/backend resource code, run `pnpm --dir android run daemon:mirror:close-loop`.
- If implementation touches Mac client resource code, run `pnpm --dir mac test -- --reporter dot` and `pnpm --dir mac run type-check`.
- If implementation touches Android app behavior, run the mapped Android runtime/UI tests and build/device gate required by the changed layer.

## Known Gaps

- This first phase locks docs and static resource gates. It does not yet prove live daemon/client behavior.
- Mac and Windows platform terminal resources may remain `binding pending` in later call maps until their platform-specific owner maps expose concrete symbols.
- Missing or uncertain symbol binding must stay explicit as `binding pending`; do not fabricate caller/callee symbols.
