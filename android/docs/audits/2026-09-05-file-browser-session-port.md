# File browser session port — first client boundary slice

Base: `33e3c80b`. Owner: this isolated `refactor/android-file-browser-boundary` worktree.

Scope: `client.file_browser_ui` / `client.file_browser`. Separate session-bound file send/subscription capability from TerminalPage; preserve existing target mux, native I/O and file payloads. This is not the complete A2/A3 migration.

Architecture mapping: separation into existing file-browser owner, no new service or alternate transport. App binds the existing session send and file-message subscription to the file-browser factory. TerminalPage selects a session by UI intent and consumes its typed port; it cannot construct daemon file scope, choose an active-session fallback, or dispatch raw wire itself. FileTransferSheet remains the existing native-I/O consumer for this slice. Its editor upload captures one sender for the operation so a later UI session cannot redirect chunks/end frames.

Allowed: App, TerminalPage, FileTransferSheet and their focused tests; `src/lib/plugin-file-browser/`; existing registry/map/architecture bindings. Forbidden: daemon/native/shared runtime, session transport policy, buffer/renderer, production config and release state.

Existing edges: `edge.client.app_shell_to_file_browser_ui` supplies the typed session port; `edge.client_file_browser_to_target_mux_request` delegates sends to the existing connection owner. Existing file-browser owned-path prefix covers the factory. No new resource truth or request ledger.

Acceptance: red/green tests for exact message identity, immutable session binding, missing capability/target failure, subscription cleanup, and page slot forwarding; an in-flight editor upload must keep its original sender across rerender. Run feature registry, relevant file-browser/App/page tests, type/build checks and browser entry where available. Source validation and installed APK/OTA remain distinct claims. No APK/OTA publication is included in this refactoring source slice.

Validation: editor-upload sender switching and retained-tab lookup both reproduced failing tests before their fixes. The resolver consumes the same materialized terminal sessions as the page, including closed tab shells. Final focused regression: 113 tests across four files passed. Registry gates: 103 tests passed; file-browser UI gate passed. Standard prebuild and build passed after generating the required local daemon artifact and nine isolated mirror close-loop fixtures; the final App lookup adjustment was rechecked with the focused suite and type-check/Vite build. Browser source entry reached Home and Settings; this is not a file-transfer device acceptance run.

Remaining boundaries: native I/O still lives in FileTransferSheet; the existing session sender's closed-transport return behavior and post-upload directory refresh are unchanged. No new APK was installed and no OTA was published. Full A2/A3 separation, architecture migration and the UI design findings remain subsequent slices in the parent audit.
