# File Transfer Test Design

## Flow

`TerminalQuickBar` opens the sync sheet, `FileTransferSheet` owns local/remote file-browser projection, `StoragePermissionPlugin` owns Android external-storage reads/writes, and daemon file-transfer runtime owns remote file state. The allowed resource edge is `resource.client_file_browser -> resource.file_transfer -> resource.backend_session`.

## Gates

- Client upload must stream from native storage with `readFileChunk(path, offset, length)` and must not call whole-file `readFile()` before chunking. This prevents WebView/native bridge OOM or renderer crash on large uploads.
- File-transfer wire chunks must use shared `FILE_TRANSFER_WIRE_CHUNK_BYTES` (16 KiB). Base64 JSON frames, including mux wrapping, must stay under `FILE_TRANSFER_WIRE_FRAME_MAX_CHARS` so RTC data-channel uploads do not exceed `maxMessageSize` and crash the app/channel.
- Client upload must wait for daemon `file-upload-progress` after each chunk before sending the next chunk, and must wait for `file-upload-complete` before finishing the transfer. Burst-sending all chunks without progress acknowledgment is forbidden because RTC DataChannel backpressure can crash the app even when each frame is under budget.
- Native chunk read must return only the requested byte span as base64, must preserve `bytesRead/eof`, and must reject oversized bridge chunks. The pure read helper must stay platform-neutral and the Capacitor plugin performs `android.util.Base64.NO_WRAP` encoding, so minSdk 24 devices do not depend on `java.util.Base64`.
- Client download may write local chunks through `writeFileChunk`; it must not collapse chunked downloads into an empty file.
- Permission/list failures are explicit UI errors, never fake empty directories.

## Commands

- `pnpm --dir android exec vitest run src/components/terminal/FileTransferSheet.test.tsx src/lib/file-transfer-session-runtime.test.ts --reporter dot`
- `cd android/native/android && ./gradlew :app:testDebugUnitTest --tests 'com.zterm.android.StorageFileReadLogicTest'`
- `pnpm --dir android exec tsc --noEmit --pretty false`
- `pnpm --dir android run test:feature-registry -- --reporter dot`
