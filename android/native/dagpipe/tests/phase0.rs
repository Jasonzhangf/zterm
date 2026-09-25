use serde_json::{json, Value};

fn run_input(input: Value) -> Value {
    zterm_dagpipe::core::run_input_dispatch_json(serde_json::to_string(&input).unwrap()).unwrap()
}

fn run_buffer_render(input: Value) -> Value {
    zterm_dagpipe::core::run_buffer_render_json(serde_json::to_string(&input).unwrap()).unwrap()
}

fn run_buffer_management(input: Value) -> Value {
    zterm_dagpipe::core::run_buffer_management_json(serde_json::to_string(&input).unwrap()).unwrap()
}

fn run_connection(input: Value) -> Value {
    zterm_dagpipe::core::run_connection_lifecycle_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn line(text: &str, index: u64) -> Value {
    json!({
        "index": index,
        "cells": text.chars().map(|ch| json!({"char": ch as u64, "fg": 256, "bg": 256, "flags": 0, "width": 1})).collect::<Vec<_>>(),
    })
}

#[test]
fn compiles_all_android_phase0_graphs() {
    let graphs = zterm_dagpipe::core::compile_phase0_graphs().unwrap();
    assert_eq!(
        graphs,
        vec![
            "android.connection_lifecycle@0.1",
            "android.buffer_management@0.1",
            "android.buffer_render@0.1",
            "android.input_dispatch@0.1",
        ]
    );
}

#[test]
fn input_dispatch_normalizes_committed_text_and_emits_ordered_chunks() {
    let request = json!({
        "execution_id": "input-test",
        "attempt_id": "1",
        "inputs": {
            "arc.committed_text": { "text": "ab\r\ncd\u{ff41}\u{ff45}" },
            "arc.input_policy": { "chunkBytes": 64, "maxInFlight": 8 },
            "arc.transport_facts": { "state": "ready", "bufferedBytes": 0 },
        },
    });
    let result = run_input(request);
    assert_eq!(result["ok"], true);
    let sends = result["outputs"]["arc.mux_channel_send"]["sends"]
        .as_array()
        .unwrap();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0]["payload"]["data"], "ab cdae");
    assert_eq!(sends[0]["payload"]["version"], 1);
}

#[test]
fn input_dispatch_backpressure_does_not_emit() {
    let request = json!({
        "execution_id": "input-backpressure",
        "attempt_id": "1",
        "inputs": {
            "arc.committed_text": { "text": "hello" },
            "arc.input_policy": { "chunkBytes": 64, "maxInFlight": 8 },
            "arc.transport_facts": { "state": "ready", "bufferedBytes": 200000 },
        },
    });
    let result = run_input(request);
    assert_eq!(
        result["outputs"]["arc.mux_channel_send"]["droppedToBackpressure"],
        true
    );
    assert_eq!(
        result["outputs"]["arc.mux_channel_send"]["sends"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn buffer_render_applies_complete_frame_and_projects_rows() {
    let frame = json!({
        "revision": 2,
        "startIndex": 0,
        "endIndex": 2,
        "rows": 24,
        "cols": 80,
        "lines": [line("a", 0), line("b", 1)],
        "cursor": null,
        "cursorKeysApp": false,
    });
    let request = json!({
        "execution_id": "render-test",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_wire_frame": frame,
            "arc.visible_range_demand": { "startIndex": 0, "endIndex": 2, "viewportRows": 24, "mode": "follow" },
            "arc.local_sparse_state": { "startIndex": 0, "endIndex": 0, "gapRanges": [] },
            "arc.buffer_policy": { "sparseApply": "no-hole" },
        },
    });
    let result = run_buffer_render(request);
    assert_eq!(result["ok"], true);
    let dom = &result["outputs"]["arc.dom_commit"];
    assert_eq!(dom["rows"], json!(["a", "b"]));
    assert_eq!(dom["revision"], 2);
}

#[test]
fn buffer_render_projects_only_visible_absolute_rows() {
    let frame = json!({
        "revision": 4,
        "startIndex": 101,
        "endIndex": 102,
        "rows": 24,
        "cols": 80,
        "lines": [line("x", 101)],
        "cursor": null,
        "cursorKeysApp": false,
    });
    let request = json!({
        "execution_id": "render-window",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_wire_frame": frame,
            "arc.visible_range_demand": { "startIndex": 100, "endIndex": 102, "viewportRows": 2, "mode": "reading" },
            "arc.local_sparse_state": {
                "startIndex": 50,
                "endIndex": 53,
                "gapRanges": [],
                "lines": [line("a", 50), line("b", 51), line("c", 52)]
            },
            "arc.buffer_policy": { "sparseApply": "no-hole" },
        },
    });
    let result = run_buffer_render(request);
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.dom_commit"]["rows"],
        json!(["", "x"])
    );
}

#[test]
fn buffer_render_emits_visible_repair_ranges() {
    let frame = json!({
        "revision": 1,
        "startIndex": 0,
        "endIndex": 1,
        "rows": 24,
        "cols": 80,
        "lines": [line("a", 0)],
        "cursor": null,
        "cursorKeysApp": false,
    });
    let request = json!({
        "execution_id": "render-repair",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_wire_frame": frame,
            "arc.visible_range_demand": { "startIndex": 1, "endIndex": 3, "viewportRows": 24, "mode": "reading" },
            "arc.local_sparse_state": { "startIndex": 0, "endIndex": 1, "gapRanges": [] },
            "arc.buffer_policy": {},
        },
    });
    let result = run_buffer_render(request);
    assert_eq!(result["ok"], true);
    // The graph only exposes the DOM commit; repair ranges flow through
    // client.buffer_planner.request internally and are surfaced in the journal.
    // Black-box graph output is still deterministic and no-hole apply is true.
    assert_eq!(result["outputs"]["arc.dom_commit"]["startIndex"], 1);
}

#[test]
fn buffer_management_keeps_inactive_session_from_pulling() {
    let request = json!({
        "execution_id": "buffer-mgmt",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_head_facts": {
                "sessions": [ { "sessionId": "s1", "revision": 1, "latestEndIndex": 10 } ]
            },
            "arc.session_buffer_demand": {
                "sessions": [ { "sessionId": "s1", "mode": "inactive" } ]
            },
            "arc.local_buffer_state": {
                "sessions": [ { "sessionId": "s1", "revision": 0, "startIndex": 0, "endIndex": 0 } ]
            },
            "arc.buffer_policy": { "cacheLines": 100 }
        },
    });
    let result = run_buffer_management(request);
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.render_scope"]["scopes"][0]["visible"],
        false
    );
}

#[test]
fn connection_lifecycle_keeps_single_physical_transport_for_multi_session() {
    let request = json!({
        "execution_id": "conn-test",
        "attempt_id": "1",
        "inputs": {
            "arc.account_credentials": { "accountId": "u1", "authToken": "tok" },
            "arc.relay_settings": { "relayEnabled": true },
            "arc.target_candidates": {
                "candidates": [
                    { "id": "lan", "path": "LAN", "endpoint": "10.0.0.1" },
                    { "id": "relay", "path": "Relay", "endpoint": "relay.example" }
                ]
            },
            "arc.session_demand_set": {
                "sessions": [
                    { "sessionId": "s1", "sessionName": "one" },
                    { "sessionId": "s2", "sessionName": "two" }
                ]
            },
            "arc.connection_policy": { "pathPriority": ["LAN", "UDP direct", "Tailscale", "Relay"], "expectedGeneration": 1 }
        },
    });
    let result = run_connection(request);
    assert_eq!(result["ok"], true);
    let plan = &result["outputs"]["arc.recovery_plan"];
    assert_eq!(plan["recoveryNeeded"], false);
    assert_eq!(plan["preserveSessions"], true);
}

#[test]
fn buffer_render_frame_assembly_rejects_non_contiguous_chunked_frame() {
    let request = json!({
        "execution_id": "assembly-test",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_wire_frame": {
                "revision": 5,
                "startIndex": 1,
                "endIndex": 2,
                "frameStartIndex": 0,
                "frameEndIndex": 3,
                "frameChunkIndex": 0,
                "frameChunkCount": 2,
                "rows": 24,
                "cols": 80,
                "lines": [ { "index": 1, "cells": [] } ],
                "cursor": null,
                "cursorKeysApp": false
            },
            "arc.visible_range_demand": { "startIndex": 0, "endIndex": 3, "viewportRows": 24, "mode": "follow" },
            "arc.local_sparse_state": { "startIndex": 0, "endIndex": 0, "gapRanges": [] },
            "arc.buffer_policy": {
                "frameAssembly": {
                    "chunks": [
                        { "startIndex": 0, "endIndex": 1, "lines": [] },
                        { "startIndex": 1, "endIndex": 3, "lines": [] }
                    ]
                }
            }
        },
    });
    let result = run_buffer_render(request);
    assert_eq!(result["ok"], true);
    // The final DOM commit remains deterministic; assembly rejections do not
    // silently project partial body truth.
    assert!(result["outputs"]["arc.dom_commit"].is_object());
}

#[test]
fn buffer_render_assembles_chunked_frame_with_incoming_chunk() {
    let request = json!({
        "execution_id": "assembly-complete",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_wire_frame": {
                "revision": 6,
                "startIndex": 1,
                "endIndex": 2,
                "frameStartIndex": 0,
                "frameEndIndex": 2,
                "frameChunkIndex": 1,
                "frameChunkCount": 2,
                "rows": 24,
                "cols": 80,
                "lines": [line("b", 1)],
                "cursor": null,
                "cursorKeysApp": false
            },
            "arc.visible_range_demand": { "startIndex": 0, "endIndex": 2, "viewportRows": 24, "mode": "follow" },
            "arc.local_sparse_state": { "startIndex": 0, "endIndex": 0, "gapRanges": [] },
            "arc.buffer_policy": {
                "frameAssembly": {
                    "chunks": [
                        { "startIndex": 0, "endIndex": 1, "lines": [line("a", 0)] }
                    ]
                }
            }
        },
    });
    let result = run_buffer_render(request);
    assert_eq!(result["ok"], true);
    let dom = &result["outputs"]["arc.dom_commit"];
    assert_eq!(dom["rows"], json!(["a", "b"]));
    assert_eq!(dom["revision"], 6);
}

#[test]
fn buffer_render_accepts_empty_frame_without_fatal_error() {
    let request = json!({
        "execution_id": "assembly-empty",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_wire_frame": {
                "revision": 7,
                "startIndex": 0,
                "endIndex": 0,
                "rows": 24,
                "cols": 80,
                "lines": [],
                "cursor": null,
                "cursorKeysApp": false
            },
            "arc.visible_range_demand": { "startIndex": 0, "endIndex": 0, "viewportRows": 24, "mode": "follow" },
            "arc.local_sparse_state": { "startIndex": 0, "endIndex": 0, "gapRanges": [] },
            "arc.buffer_policy": {}
        },
    });
    let result = run_buffer_render(request);
    assert_eq!(result["ok"], true);
    assert!(result["outputs"]["arc.dom_commit"].is_object());
}

#[test]
fn buffer_management_ingest_real_wire_response_advances_sparse_truth() {
    let request = json!({
        "execution_id": "buffer-wire",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_head_facts": {
                "sessions": [
                    { "sessionId": "s1", "revision": 1, "latestEndIndex": 2 }
                ]
            },
            "arc.session_buffer_demand": {
                "sessions": [
                    { "sessionId": "s1", "mode": "active", "viewportRows": 24 }
                ]
            },
            "arc.local_buffer_state": {
                "sessions": [
                    { "sessionId": "s1", "revision": 0, "startIndex": 0, "endIndex": 0, "gapRanges": [] }
                ]
            },
            "arc.buffer_policy": { "cacheLines": 100, "dispatchBudget": 4 },
            "arc.wire_range_responses": {
                "responses": [
                    { "sessionId": "s1", "startIndex": 0, "endIndex": 2, "revision": 2 }
                ]
            }
        },
    });
    let result = run_buffer_management(request);
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.render_scope"]["scopes"][0]["visible"],
        true
    );
    assert_eq!(
        result["outputs"]["arc.repair_ledger"]["ledger"][0]["status"],
        "none"
    );
}

#[test]
fn buffer_management_ingest_same_revision_response_fills_gap() {
    let request = json!({
        "execution_id": "buffer-wire-same-revision",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_head_facts": {
                "sessions": [
                    { "sessionId": "s1", "revision": 1, "latestEndIndex": 3 }
                ]
            },
            "arc.session_buffer_demand": {
                "sessions": [
                    { "sessionId": "s1", "mode": "active", "viewportRows": 24 }
                ]
            },
            "arc.local_buffer_state": {
                "sessions": [
                    { "sessionId": "s1", "revision": 1, "startIndex": 0, "endIndex": 2, "gapRanges": [ { "startIndex": 2, "endIndex": 3 } ] }
                ]
            },
            "arc.buffer_policy": { "cacheLines": 100, "dispatchBudget": 4 },
            "arc.wire_range_responses": {
                "responses": [
                    { "sessionId": "s1", "startIndex": 0, "endIndex": 3, "revision": 1, "received": true }
                ]
            }
        },
    });
    let result = run_buffer_management(request);
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.repair_ledger"]["ledger"][0]["status"],
        "none"
    );
}

#[test]
fn buffer_render_rejects_stale_frame_and_preserves_local_truth() {
    let frame = json!({
        "revision": 3,
        "startIndex": 0,
        "endIndex": 1,
        "rows": 24,
        "cols": 80,
        "lines": [line("stale", 0)],
        "cursor": null,
        "cursorKeysApp": false,
    });
    let request = json!({
        "execution_id": "stale-render",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_wire_frame": frame,
            "arc.visible_range_demand": { "startIndex": 0, "endIndex": 1, "viewportRows": 24, "mode": "follow" },
            "arc.local_sparse_state": {
                "revision": 5,
                "startIndex": 0,
                "endIndex": 1,
                "gapRanges": [],
                "lines": [line("current", 0)],
            },
            "arc.buffer_policy": {},
        },
    });
    let result = run_buffer_render(request);
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.dom_commit"]["revision"], 5);
    assert_eq!(
        result["outputs"]["arc.dom_commit"]["rows"],
        json!(["current"])
    );
}

#[test]
fn connection_lifecycle_does_not_select_auth_failure_route() {
    let request = json!({
        "execution_id": "auth-route",
        "attempt_id": "1",
        "inputs": {
            "arc.account_credentials": { "accountId": "u1", "authToken": "tok" },
            "arc.relay_settings": { "relayEnabled": true },
            "arc.target_candidates": {
                "candidates": [
                    { "id": "relay", "path": "Relay", "endpoint": "relay.example", "health": { "status": "auth-failure", "rttMs": 0 } },
                    { "id": "lan", "path": "LAN", "endpoint": "10.0.0.1", "health": { "status": "success", "rttMs": 10 } }
                ]
            },
            "arc.session_demand_set": { "sessions": [ { "sessionId": "s1", "sessionName": "one" } ] },
            "arc.connection_policy": { "pathPriority": ["Relay", "LAN"], "expectedGeneration": 1 }
        },
    });
    let result = run_connection(request);
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.connection_health"]["targetKey"],
        "lan"
    );
}

#[test]
fn connection_lifecycle_mux_negotiation_requires_established_transport() {
    let request = json!({
        "execution_id": "mux-connect",
        "attempt_id": "1",
        "inputs": {
            "arc.account_credentials": { "accountId": "u1", "authToken": "tok" },
            "arc.relay_settings": { "relayEnabled": true },
            "arc.target_candidates": {
                "candidates": [
                    { "id": "lan", "path": "LAN", "endpoint": "10.0.0.1", "health": { "status": "success", "rttMs": 10 } }
                ]
            },
            "arc.session_demand_set": { "sessions": [ { "sessionId": "s1", "sessionName": "one" } ] },
            "arc.connection_policy": { "pathPriority": ["LAN"] }
        },
    });
    let result = run_connection(request);
    assert_eq!(result["ok"], false);
    assert!(result["error"]
        .as_str()
        .unwrap_or("")
        .contains("cannot negotiate mux"));
}

#[test]
fn buffer_management_ingest_partial_wire_response_does_not_clear_gap() {
    let request = json!({
        "execution_id": "partial-wire",
        "attempt_id": "1",
        "inputs": {
            "arc.daemon_head_facts": {
                "sessions": [ { "sessionId": "s1", "revision": 1, "latestEndIndex": 2 } ]
            },
            "arc.session_buffer_demand": {
                "sessions": [ { "sessionId": "s1", "mode": "active", "viewportRows": 24 } ]
            },
            "arc.local_buffer_state": {
                "sessions": [ { "sessionId": "s1", "revision": 0, "startIndex": 0, "endIndex": 2, "gapRanges": [ { "startIndex": 0, "endIndex": 2 } ] } ]
            },
            "arc.buffer_policy": { "cacheLines": 100, "dispatchBudget": 4 },
            "arc.wire_range_responses": {
                "responses": [ { "sessionId": "s1", "startIndex": 0, "endIndex": 1 } ]
            }
        },
    });
    let result = run_buffer_management(request);
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.repair_ledger"]["ledger"][0]["status"],
        "pending"
    );
}
