# Phase 8 Architecture Audit

Date: 2026-08-26
Auditor: pane-581
Run: 20260826T220000Z-Macstudio-pane581-phase8audit
Base: 04d41de18bd68ae21d8a8b121221acf5c277a0bd

## Audit Scope

All registry gates across verification-map, module-registry, resource-registry,
function-map, mainline-call-map, and CI binding.

## Findings

### Static Gates - ALL PASS

| Gate | Sub-check | Result |
|------|-----------|--------|
| `gate.map.parse` | JSON parse + schema | PASS |
| `gate.owner.uniqueness` | each source file has exactly one owner | PASS |
| `gate.import.edges` | cross-module imports hit registered edges | PASS |
| `gate.mainline.adjacency` | all mainline nodes anchored, no unanchored edges | PASS |
| `gate.module.dag` | no circular dependencies among modules | PASS |
| `gate.target.status` | all registry entries have valid status | PASS |
| `gate.symbol.exists` | all declared entry_symbols exist in source | PASS |
| `gate.git.diff.check` | status=null (not enforced in CI) | INACTIVE |
| `gate.shared.core.imports` | shared domain_core has no forbidden imports | PASS |
| `gate.payload.isolation` | Cordis/terminal-data-stream, UI/domain-state, debug/data-plane | PASS |

### Runtime Gates - ALL ACTIVE

All 16 runtime/package gates have `status: "active"` and a defined command.
Commands cover: stream boundary, kernel lifecycle pairs, cordis process-local,
host typecheck/build, IPC codec, stale generation, session route replay,
persistence settings replay, terminal transport lifecycle, terminal buffer render,
file media input, iOS host contract, iOS package, UI react adapter,
low-risk plugin UI ownership, desktop packaged parity.

### Mainline Call Map - FULLY ANCHORED

All 9 mainlines have all edges `status: "anchored"`. Zero edges with
`status: "pending"`. Nodes cover: android_renderer, android_daemon,
android_low_risk_plugin, mac_renderer, desktop_host_gateway, kernel,
stream_boundary, terminal_buffer_render, file_media_input.

### Phase Manifest - SYNCHRONIZED

- Phase 0-6: `status: complete`
- Phase 7: `status: active`, gates: ios-device, windows-conpty, desktop-packaged, four-platform-parity
- Phase 8: `status: blocked-on-phase-7`, gates: main-tree-verify, agy-review-pass, staged-scope, push-head-equality

### Module Registry - 17 ACTIVE MODULES

All have `owned_paths`, `forbidden_imports`, and `required_gates` defined.
No orphaned modules. Each source file has exactly one owner.

### Resource Registry - 15 RESOURCES

All have owner, truth_store, direct_relations, and forbidden_direct_relations.
Key isolation contracts enforced:
- `resource.cordis_context` -> forbids `resource.terminal_data_stream`
- `resource.ui_projection` -> forbids `resource.domain_state` writes
- `resource.terminal_data_stream` -> forbids `resource.debug_snapshot_registry`

### CI Binding - INCOMPLETE

**Covered in CI (`cordis-v2-governance` job):**
- map-registries (all static gates)
- cordis-v2-governance positive/negative validators
- kernel-lifecycle (lifecycle pairs)
- stream-boundary (data stream boundary)
- iOS host contract
- UI react adapter

**NOT covered in CI (missing job wiring):**
- `gate.ipc.codec` (desktop-gateway IPC codec tests)
- `gate.stale.generation` (desktop-gateway stale generation tests)
- `gate.session.route.replay` (shared session route projection replay)
- `gate.persistence.settings.replay` (shared persistence settings replay)
- `gate.terminal.transport.lifecycle` (terminal transport lifecycle tests)
- `gate.terminal.buffer.render` (terminal buffer render tests)
- `gate.file.media.input` (file media input tests)
- `gate.low.risk.plugin.ui.ownership` (Android low-risk plugin tests)
- `gate.desktop.packaged` (desktop packaged parity gate, only wired in mac-desktop-split job)

## Gaps and Risks

### G1 - Runtime Gates Not Wired to CI (MEDIUM)

9 runtime gates are `active` with defined commands but not executed by any CI job.
These must be added to `cordis-v2-governance` or a new CI job to satisfy AGENTS rule 22a
("Gate must be connected to CI/build chain").

### G2 - `gate.git.diff.check` Has No Status (LOW)

No `status` field on `gate.git.diff.check`. Not enforced in CI.

### G3 - Phase-manifest Gate Names vs Registry IDs (NOMINAL)

Phase manifest gates use descriptive names (e.g., `ios-device`, `desktop-packaged`)
that differ from registry gate IDs (e.g., `gate.ios.host.contract`, `gate.desktop.packaged`).
This is intentional naming divergence, not a functional gap.

## Recommended Actions

1. Add a `cordis-v2-runtime-gates` CI job that runs all 9 missing runtime gates.
2. Set `status: "inactive"` or remove `gate.git.diff.check` from verification-map.
3. Add `gate.desktop.packaged` to `cordis-v2-governance` or the `mac-desktop-split` job.

## Verification Evidence

All static gates verified by:

```bash
node scripts/check-zterm-v2-map-registries.mjs           # all gates PASS
node scripts/check-zterm-v2-map-registries.mjs --only=ownership  # PASS
node scripts/check-zterm-v2-map-registries.mjs --only=imports    # PASS
node scripts/check-zterm-v2-map-registries.mjs --only=shared      # PASS
node scripts/check-zterm-v2-map-registries.mjs --only=payload     # PASS
node scripts/check-zterm-v2-map-registries.mjs --only=symbols     # PASS
node scripts/check-zterm-v2-map-registries.mjs --only=status      # PASS
node scripts/check-zterm-v2-map-registries.mjs --only=dag         # PASS
node scripts/check-zterm-v2-map-registries.mjs --only=mainline    # PASS
```

Runtime gate commands are defined but not executed in CI for G1 gates.
