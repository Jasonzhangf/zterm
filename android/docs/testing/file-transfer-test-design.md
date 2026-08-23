# File Transfer Test Design

## Ownership And Architecture Mapping

- Feature block: `daemon.file_transfer`.
- Client owner: `client.file_browser`, with `src/lib/file-transfer-throughput-runtime.ts` as the only upload-window and native-write batch policy owner. `FileTransferSheet` only orchestrates selection and calls this owner.
- Daemon owner: `daemon.file_transfer`, with the binary runtime owning cumulative upload acknowledgment truth and the list runtime owning download wire emission.
- Shared contract owner: `shared.terminal_types`; the 16 KiB wire frame limit remains unchanged.
- Throughput policy truth: `contracts/file-transfer-throughput.json`; TypeScript imports it directly and Android Gradle binds the same value into `BuildConfig`.
- Resource route: `resource.client_file_browser -> resource.target_mux_request -> resource.daemon_target_transport -> resource.transport_subscriber -> resource.file_transfer -> resource.backend_session`.
- Module ownership is machine-locked separately from the legacy cross-side `feature_id=daemon.file_transfer`: `client.file_browser` owns `resource.client_file_browser`, `client.runtime` owns `resource.client_native_file_store`, and `daemon.file_transfer` owns `resource.file_transfer`. The feature id must never be interpreted as permission for daemon code to own client storage or UI projection.
- Classification: **separation downward**. Flow-control policy leaves the UI component and is bound to one client runtime helper; native batch persistence remains behind the Capacitor storage interface. Unbounded upload burst and per-wire-chunk native writes are physically forbidden by tests. Download chunks are still assembled in WebView memory before batched persistence and remain a documented gap.

## Rust Migration Register

- Current active owner: `src/lib/file-transfer-throughput-runtime.ts` owns upload cumulative-ACK window scheduling and native download batch partitioning; `contracts/file-transfer-throughput.json` owns the numeric policy.
- Target owner: a future shared Rust `file_transfer_throughput` contract/runtime exposed through a thin TypeScript bridge. This is `planned`, not active runtime truth.
- Activation gates: byte-for-byte parity for the 1 MiB bidirectional SHA-256 loopback; identical maximum in-flight chunk count; identical native batch boundaries; identical success/error timing for incomplete, duplicate, conflicting, and exact-complete uploads.
- Physical deletion condition: remove the TypeScript owner only after the Rust artifact, bridge, parity gate, Android build integration, function map, mainline call map, and feature/resource registries are all active in one change set. Until then, no second TS/native policy implementation is allowed.

## Flow

`TerminalQuickBar` opens the sync sheet, `FileTransferSheet` owns local/remote file-browser projection, `file-transfer-throughput-runtime` owns bounded upload and download batching policy, `StoragePermissionPlugin` owns Android external-storage reads/writes, and daemon file-transfer runtime owns remote file state.

### Upload Lifecycle

1. Client sends `file-upload-start` once.
2. Client reads and sends at most `FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS` 16 KiB chunks ahead of the daemon's cumulative contiguous ACK.
3. Daemon accepts each chunk index at most once, advances ACK only through the highest continuous prefix, and emits `file-upload-progress` with that prefix length.
4. Client sends `file-upload-end` only after every chunk is cumulatively acknowledged.
5. Daemon validates exact chunk count and byte count before publishing `file-upload-complete`; errors remain explicit.

### Paste-Image Lifecycle

1. Client sends a request-bound `file-upload-start` carrying paste-image metadata; daemon ignores client target/file names for this mode and stages bytes under its private upload directory.
2. Client sends at most eight unacknowledged chunks through the same bounded window owner and resumes from the latest cumulative ACK.
3. Daemon validates exact chunk count, total byte length, and persisted stat before acknowledging completion; duplicate identical chunks remain idempotent.
4. Client sends `paste-image-from-upload` only after completion. Daemon consumes staged bytes once, normalizes to PNG, injects clipboard/input, and deletes staging.

### Download Lifecycle

1. Daemon emits 16 KiB wire chunks without changing payload semantics.
2. Client preserves chunk order and exact payload content.
3. Android persists at most `FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS` chunks in one native bridge call. The plugin opens one output stream per batch and writes each decoded chunk in order.
4. Client validates final on-disk size before publishing transfer completion.

## Gates

- Canonical executable gate: `scripts/run-file-transfer-throughput-gate.sh`, invoked by `pnpm run test:file-transfer:throughput`. Both CI and `prebuild` must execute this command; listing test paths in the registry without executing this gate is forbidden.

- Client upload must stream from native storage with `readFileChunk(path, offset, length)` and must not call whole-file `readFile()` before chunking. This prevents WebView/native bridge OOM or renderer crash on large uploads.
- File-transfer wire chunks must use shared `FILE_TRANSFER_WIRE_CHUNK_BYTES` (16 KiB). Base64 JSON frames, including mux wrapping, must stay under `FILE_TRANSFER_WIRE_FRAME_MAX_CHARS` so RTC data-channel uploads do not exceed `maxMessageSize` and crash the app/channel.
- Client upload must use the single bounded-window owner. It may send at most eight chunks ahead of the daemon's cumulative contiguous `file-upload-progress`; sending chunk 9 before ACK 1 is forbidden. Stop-and-wait is also forbidden because it caps throughput at one 16 KiB chunk per RTT.
- The upload-window and native-write batch sizes are fixed owner constants. Callers cannot override them through options.
- The TypeScript runtime and Java writer cannot define independent numeric batch limits. `file-transfer-throughput-contract.test.ts` locks the JSON import, Gradle `BuildConfig` binding, and Java consumption in the canonical gate.
- Daemon ACK must be duplicate-safe and contiguous. A duplicate chunk cannot advance progress; an out-of-order chunk cannot acknowledge a missing gap; invalid indexes and final byte-count mismatch are explicit errors.
- Native chunk read must return only the requested byte span as base64, must preserve `bytesRead/eof`, and must reject oversized bridge chunks. The pure read helper must stay platform-neutral and the Capacitor plugin performs `android.util.Base64.NO_WRAP` encoding, so minSdk 24 devices do not depend on `java.util.Base64`.
- Client download must batch native persistence without changing wire chunk semantics. Eight 16 KiB chunks are at most one 128 KiB native batch; a 100 MiB transfer therefore uses at most 800 native write calls instead of 6,400. Batch order, append semantics, empty-file behavior, and final size must be exact.
- Native batch write must reject an empty batch and an oversized batch. It must not concatenate padded base64 strings before decoding.
- Permission/list failures are explicit UI errors, never fake empty directories.
- Remote browser mode is a current-cwd browser, not the sync sheet. It must not read/show local sync directories, must avoid fixed-height blank panels, and must route text/code preview through bounded download chunks.
- Remote text preview must decode each base64 wire chunk independently before TextDecoder streaming. Padded base64 chunks must never be concatenated and decoded as one string.
- Daemon remote directory listing is cached by resolved path. A list request reads the cache and applies only projection filtering; file-system changes are observed by a path-local watcher that refreshes the cache. Do not rescan whole trees or walk beyond the requested directory for each connection.

## Positive And Negative Matrix

| Layer | Positive | Negative |
| --- | --- | --- |
| White box | chunks 0-7 send before an ACK; ACK 1 opens exactly one new slot | chunk 8 cannot send while cumulative ACK is 0; stop-and-wait and unbounded burst red tests fail |
| Daemon module black box | unique ordered chunks advance cumulative ACK and exact file completes | duplicate/out-of-order/invalid/missing chunks do not over-ack or publish success |
| Native module black box | eight base64 chunks persist in exact order through one stream | empty/oversized batch and invalid base64 fail explicitly without success truth |
| Project black box | real client uploads and downloads a deterministic file; source and target SHA-256 match | induced ACK delay keeps in-flight chunks bounded; interrupted transfer never reports complete |

## Performance Gates

- Deterministic 100 MiB model: stop-and-wait exposes only one 16 KiB chunk per RTT; the bounded sliding window exposes up to eight chunks per RTT while never exceeding eight unacknowledged chunks.
- Deterministic 100 MiB native persistence model: per-wire-chunk baseline is 6,400 bridge calls; batch size 8 is no more than 800 calls.
- In-process client/daemon module loopback records bytes, duration, ACK count, maximum in-flight chunks, native batch call count, and source/target SHA-256. A product speed claim still requires a real transport and Android device; module loopback only proves byte truth and flow-control behavior.

## Known Gaps

- Download still uses daemon whole-file `readFileSync` and client whole-transfer `downloadChunks` assembly before native persistence. This change accelerates bridge persistence but does not yet provide bounded-memory streaming download.
- Real WebSocket/RTC plus Android device throughput and SHA-256 comparison are pending. No product speed claim is valid until that black-box gate runs.

## Commands

- `pnpm --dir android run test:file-transfer:throughput`
- `cd android/native/android && ./gradlew :app:testDebugUnitTest --tests 'com.zterm.android.StorageFileReadLogicTest' --tests 'com.zterm.android.StorageFileWriteLogicTest'`
- `pnpm --dir android exec tsc --noEmit --pretty false`
- `pnpm --dir android run test:feature-registry -- --reporter dot`
