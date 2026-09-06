<!-- project-memory:v1 {"category":"lesson","created_at":"2026-09-05T12:49:44.926890+00:00","id":"zterm-current-runtime-truth-separation","importance":100,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":["docs/decisions/2026-09-05-runtime-memory-truth.md","docs/function-map.md","packages/kernel/src/cordis/index.ts","src/App.tsx"],"tags":["architecture","evidence","function-map","implementation-truth","target-truth"],"updated_at":"2026-09-05T12:49:44.926890+00:00"} -->

# Separate verified implementation from confirmed target design

Architecture documents and function maps are not runtime proof. For zterm, inspect the production owner and call chain before classifying a statement. Record code-verified current implementation and user-confirmed target design separately; never promote a target such as Cordis adoption, Android Service route ownership, TOML configuration, or a new buffer policy to current truth before its physical implementation and gates pass.
<!-- project-memory:end -->
