<!-- project-memory:v1 {"category":"path","created_at":"2026-09-05T12:49:44.940817+00:00","id":"zterm-terminal-data-owner-path","importance":99,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":["docs/architecture.md","docs/decisions/2026-09-05-runtime-memory-truth.md","docs/function-map.md"],"tags":["flow","frame-assembly","mirror","owner","sparse-buffer","terminal","ui"],"updated_at":"2026-09-05T12:49:44.940817+00:00"} -->

# Terminal data owner path

Terminal data flows from source adapter to daemon mirror writer, daemon mirror store, daemon buffer publisher, physical transport and mux channel, client frame assembly, client sparse buffer and buffer store, renderer window, DOM terminal renderer, terminal shell, then container/layout and App projection. Publisher owns contiguous wire publication and subscriber backpressure; frame assembly publishes only complete continuous frames; sparse buffer owns absolute-row data and holes; renderer owns only the visible projection. Terminal renderer, video renderer, container/layout, and UI composition remain separate owners.
<!-- project-memory:end -->
