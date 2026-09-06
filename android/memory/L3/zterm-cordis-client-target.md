<!-- project-memory:v1 {"category":"plan","created_at":"2026-09-05T12:49:44.948193+00:00","id":"zterm-cordis-client-target","importance":98,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":["docs/decisions/2026-09-05-runtime-memory-truth.md","packages/kernel/src/cordis/index.ts","src/App.tsx","src/lib/composition-root/client-composition-root.ts","src/lib/plugin-host/plugin-host-runtime.ts"],"tags":["client","composition","cordis","lifecycle","plugin","target"],"updated_at":"2026-09-05T12:49:44.948193+00:00"} -->

# Cordis client composition target

The confirmed target client uses Cordis as the production composition and lifecycle owner. Transport, session, buffer, and renderer are fixed Cordis services/nodes; UI and business capabilities are plugins. Cordis carries lifecycle and capability control, never terminal, file, or media body payloads. Current production still uses ClientCompositionRoot plus the local PluginHost, while CordisAdapter is Playground-only; migration must end with one production composition owner and no retained dual path.
<!-- project-memory:end -->
