# Architecture And AppSDK Audit Closeout Plan

## 1. Goal And Acceptance Criteria

Close every blocker and high-risk gap from the 2026-08-19 architecture audit without changing product behavior or business payload semantics.

Acceptance requires all of the following:

1. Current mainline code, architecture maps, review evidence, generated artifact, Active pointer, and Protected archive bind to one exact source commit/tree.
2. `client.connection_service` and its implemented resources/edges are either fully active with complete bindings and gates, or absent from production. No implemented path remains mislabeled as design/pending.
3. Every production source file has exactly one machine-verified module owner. Every real cross-module dependency is registered, allowed, adjacent, and acyclic.
4. Data, control, debug, metadata, and error semantics remain physically separated. No control state enters business payloads.
5. Large production orchestrators are split along existing resource/module owners until each resulting file has one coherent responsibility and is normally at most 500 lines. Exceptions require a machine-readable exemption, owner, reason, limit, and ratchet gate.
6. AppSDK verification, project gates, build, native tests, runtime replay, online device evidence, final DSH architecture review, effectiveness replay, promotion, Active publication, Protected freeze, and final verification all pass against unchanged source.

The correct coupling target is not zero dependencies. It is zero undeclared, cyclic, reverse, shortcut, duplicate-owner, or cross-plane coupling.

## 2. Scope And Boundaries

### In Scope

- `android/.appsdk/**` project contracts, maps, lifecycle records, generated references, and SDK lock verification.
- `android/docs/{resource-registry,module-registry,edge-registry}.json` and their human review surfaces.
- Function map, mainline call map/source, verification map, feature registry, feature gates, test designs, and CI/prebuild wiring.
- Android TypeScript/TSX, native Java, project/shared source, build/release scripts, CSS, Gradle, and Capacitor bridge ownership/dependency gates.
- Implemented `client.connection_service` production path and its typed IPC/error boundaries.
- Production files over the project 500-line default, prioritized by fan-out and state ownership.
- New AppSDK lifecycle version after `active-v4`; old Active/Protected history stays immutable.

### Out Of Scope

- UI/product redesign.
- Mac, Windows, or `../wterm` runtime refactors unless a verified current Android edge requires a shared contract change.
- Implementing future design-only features such as remote-window canvas resources.
- Changing terminal/file/media business payload semantics.
- Fallback, dual production paths, compatibility shadow owners, or weakening tests to obtain PASS.
- OTA/public release without Jason's explicit authorization.

## 3. Design Principles

1. Resource registry first; then function map, mainline call map, module registry, verification map, tests, and implementation.
2. One resource and one feature have one physical owner. Orchestration wires owners; it does not keep business truth.
3. Only adjacent typed edges. Control, debug, metadata, and errors use dedicated side channels/error chains.
4. Existing behavior remains stable through characterization tests, positive/negative gates, and real-entry replay.
5. AppSDK is external and digest-pinned. Project stores only contracts, lifecycle records, generated artifacts, Active, and Protected history.
6. `active-v4` and existing Protected versions are immutable. Use a new AppSDK version lifecycle for current mainline.
7. Review/effectiveness evidence is valid only for the exact unchanged candidate commit, tree, map hashes, scope hash, artifact hash, and public API hash.
8. Main worktree and unrelated dirty files remain untouched. All changes use one clean declared owner worktree and semantic claim.

## 4. Technical Plan And File Surface

### 4.1 Establish Exact Baseline

- Record current mainline commit/tree, dirty state, active-v4 hashes, current map hashes, current AppSDK failure, and current gate outputs.
- Create `.agent-collab` run/claim evidence and one clean worktree under `playground/` from the declared base.
- Start the next AppSDK module version from `active-v4` before formal source edits.
- Preserve current untracked AppSDK/lifecycle evidence and unrelated logo/note changes; do not absorb them without provenance.

Primary files:

- `.appsdk/project.json`
- `.appsdk/goal.json`
- `.appsdk/sdk.lock`
- `.appsdk/records/**`
- `active/lib/zterm-runtime-v2/**`
- `protected/history-versions/zterm-runtime-v2/**`
- `generated/modules/zterm-runtime-v2/**`

### 4.2 Reconcile Connection-Service Current Truth

- Trace the live entry-to-native-service path and prove the unique owner, resource relationships, command/response/error chains, IPC boundary, and forbidden paths.
- Complete positive and negative tests for bind/release, route policy, generation rejection, reconnect/backoff, snapshot projection, explicit physical errors, and control/payload separation.
- Remove any old physical-transport owner or dual socket path after dependency proof.
- Promote implemented connection-service module/resources/edges from design/partial to active only after code bindings and required gates are real.

Primary files:

- `docs/resource-registry.json`
- `docs/module-registry.json`
- `docs/edge-registry.json`
- `docs/function-map.md`
- `docs/wiki/mainline-call-map.json`
- `docs/wiki/mainline-source.md`
- `.appsdk/maps/{resource-map,module-registry,function-map,mainline-call-map,verification-map}.json`
- `src/lib/android-connection-service-*.ts`
- `src/plugins/AndroidConnectionServicePlugin.ts`
- `src/contexts/android-connection-service-runtime.ts`
- `native/android/app/src/main/java/com/zterm/android/AndroidConnectionService.java`
- `native/android/app/src/main/java/com/zterm/android/AndroidConnectionServicePlugin.java`

### 4.3 Expand Architecture Gates To Full Production Source

- Replace the TS-only ownership claim with a full production-source inventory.
- Cover TS/TSX, the complete shared source surface, Java, JavaScript/MJS, shell, CSS, Gradle, and future registered Rust source.
- Verify every source file has exactly one active or explicitly design/pending owner according to its runtime status.
- Parse language-appropriate dependency/import graphs. Bind every cross-module edge to `edge-registry`; reject undeclared and stale edges.
- Add call/mainline gates for dependency-injected callbacks, native bridge methods, protocol handlers, HTTP routes, WebSocket/mux dispatch, shell/build/release entrypoints, and runtime factories where import edges alone cannot prove ownership.
- Keep the DAG and adjacent-resource checks. Add red fixtures proving native/script/unregistered-call violations fail.

Primary files:

- `src/lib/module-registry-truth.test.ts`
- `src/lib/module-import-graph-truth.test.ts`
- `src/lib/edge-registry-truth.test.ts`
- `src/lib/mainline-resource-call-map.test.ts`
- `src/lib/function-wiki-truth.test.ts`
- `scripts/**` only through existing canonical gate/generator owners
- `.github/workflows/ci.yml`
- `package.json`

### 4.4 Reduce Internal God-Module Coupling

Refactor in owner-preserving slices, beginning with the highest-risk production files:

- `src/components/terminal/RemoteWindowOverlay.tsx`
- `src/components/terminal/TerminalQuickBar.tsx`
- `src/pages/TerminalPage.tsx`
- `src/components/terminal/FileTransferSheet.tsx`
- `src/components/TerminalView.tsx`
- `src/contexts/session-context-buffer-runtime.ts`
- `src/lib/remote-window-touch-action-runtime.ts`
- `src/components/tmux/TmuxSessionPickerSheet.tsx`
- `native/android/app/src/main/java/com/zterm/android/AndroidConnectionService.java`
- `src/traversal-relay/server.ts`
- `src/server/remote-window-stream-daemon.ts`
- `src/hooks/useSessionOpenActions.ts`
- `src/App.tsx`
- `src/contexts/session-context-transport-orchestration-runtime.ts`
- `src/components/terminal/TerminalSessionDrawer.tsx`

Rules:

- Split by existing resource truth, lifecycle state, pure projection, typed adapter, and orchestration responsibility.
- Do not introduce shared/global event buses or duplicate DTOs.
- Public behavior and business payloads remain byte/semantic equivalent.
- Each slice gets characterization tests before movement and positive/negative tests after movement.
- Add a production-file size/responsibility ratchet to prebuild and CI. Explicit exceptions must shrink over time and cannot hide mixed owners.

### 4.5 Restore AppSDK Lifecycle Truth

- Regenerate current maps only through their owning authoring/generator flow.
- Create exact reproduction, fix candidate, evidence, architecture ReviewRecord, effectiveness, merge, promotion, regression, freeze, and cleanup records for the new version.
- Bind the final ReviewRecord to current resource/function/mainline/module/verification map hashes.
- Compile deterministic artifacts; prove artifact hash and public API hash.
- Publish a new immutable Active version and archive matching source/contracts/evidence to Protected.
- Keep `active-v4` unchanged.
- Prove the ignored local `.appsdk/sdk.bin` is unused. Removal requires Jason's explicit authorization; absence of authorization must remain an explicit closeout gap rather than silent deletion.

## 5. Risks And Controls

| Risk | Control |
|---|---|
| Refactor changes runtime behavior | Characterization tests, small owner-preserving slices, exact input replay, online sample |
| Registry says active before code is ready | Status promotion occurs last; gates reject active resources without bindings |
| Review becomes stale | Freeze source/maps after candidate commit; any change invalidates review/effectiveness |
| File splitting creates duplicate owners | One owner per extracted unit; old implementation physically removed after dependency proof |
| Native/script code remains outside graph | Full-source inventory and language-specific edge gates in prebuild/CI |
| Current dirty work is overwritten | Clean isolated worktree; precise merge/stage; no checkout/reset |
| Old AppSDK binary becomes second path | Exact global 0.1.3 digest gate; no execution of local stale binary |
| Runtime evidence uses old APK/daemon | Record source commit, artifact/APK hash, installed version, daemon version, and device route together |

## 6. Verification Matrix

### Architecture And Static

- AppSDK binary/digest negative and positive tests.
- Feature/resource/module/edge/function/mainline/verification registry gates.
- Full-source ownership coverage and import/call DAG gates.
- Payload/control/debug/error separation red tests.
- Production file-size/responsibility ratchet.
- TypeScript type-check and source-pollution scan.

### Focused Functional

- Connection-service owner and native state-machine tests.
- Transport/network lifecycle and mux tests.
- Session, buffer, renderer, terminal shell, input, file, remote-window, relay, plugin, control, and debug owner suites affected by decomposition.
- Positive and negative cases for success, failure, non-terminal, already-terminal, stale generation, and forbidden shortcut paths.

### Build And Native

- Full `prebuild` and production web build.
- Android Java compile and unit tests.
- APK build only when the source candidate is ready for runtime verification; preserve device data.

### Runtime

- Daemon/tmux close-loop and strict audit.
- Exact source-to-daemon-to-client-to-render replay.
- Online ADB install/upgrade, app launch, connection-service transport recovery, terminal input/output, render continuity, and error projection.
- Record versionName, versionCode, APK SHA-256, daemon artifact identity, device identity, and screenshots/logs.
- OTA/public release remains separately authorization-gated.

### Review And AppSDK

- DSH architecture review through `opencode-go/deepseek-v4-flash` after all source/build/runtime verification.
- Fix every P0/P1; rerun affected verification after any source/config change.
- Unchanged-source effectiveness replay.
- New Active/Protected publication and final `appsdk verify android` with `ok:true`.

## 7. Execution Order

1. Baseline and semantic claim/worktree declaration.
2. Begin new AppSDK version from active-v4.
3. Reconcile resource/module/edge/function/mainline truth for connection service.
4. Add full-source ownership and dependency/call-graph red gates.
5. Complete connection-service owner migration and remove duplicate paths.
6. Refactor oversized production modules in independently verified owner slices.
7. Run complete architecture/static/focused/build/native/runtime stack.
8. Commit the exact candidate and compute source/tree/diff/scope/map/artifact/API hashes.
9. Run DSH architecture review; fix/reverify/re-review until PASS.
10. Run unchanged-source effectiveness replay.
11. Merge precisely to main and rerun affected mainline verification/runtime evidence.
12. Compile, promote, publish new Active, freeze Protected, verify the record graph, and close Playground.
13. Confirm final mainline clean identity and report any authorization-gated residue.

## 8. Definition Of Done

- No implemented module/resource/edge is left in design/pending/partial state.
- Future design-only resources remain visibly separate and have no production bindings.
- Every production source file has exactly one machine-verified owner.
- Every cross-module import/call edge is registered, adjacent, allowed, and acyclic.
- No duplicate owner, fallback, control/payload leak, silent failure, stale map, stale review, or old Active mutation exists.
- Oversized production files satisfy the 500-line ratchet or have a justified, bounded, shrinking machine exemption.
- All project gates, full build, native tests, daemon/runtime replay, and online device checks pass.
- DSH returns an unambiguous architecture PASS on the final unchanged candidate.
- New AppSDK Active/Protected version binds the exact final mainline commit, maps, artifact, public API, regression evidence, and freeze record.
- `appsdk verify android` and `pnpm --dir android run test:appsdk-verify` both pass.
- Final report lists changes, root causes, owner alignment, positive/negative evidence, remaining authorization-gated actions, and exact hashes.
