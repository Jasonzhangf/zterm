use serde_json::json;

fn cell(ch: &str) -> serde_json::Value {
    json!({ "char": ch.chars().next().map(|c| c as u32).unwrap_or(32), "fg": 256, "bg": 256, "flags": 0, "width": 1 })
}

fn line(text: &str) -> serde_json::Value {
    json!(text
        .chars()
        .map(|c| cell(&c.to_string()))
        .collect::<Vec<_>>())
}

fn mirror_request(
    prev_start: u64,
    prev_lines: &[&str],
    next_start: u64,
    next_lines: &[&str],
    policy: serde_json::Value,
    subscribers: serde_json::Value,
) -> serde_json::Value {
    json!({
        "execution_id": "phase0-test",
        "attempt_id": "1",
        "inputs": {
            "arc.source_readback": {
                "revision": 4,
                "bufferStartIndex": next_start,
                "bufferLines": next_lines.iter().map(|text| line(text)).collect::<Vec<_>>(),
                "rows": 3,
                "cols": 20,
                "cursorKeysApp": false,
                "cursor": null,
            },
            "arc.diff_policy": policy,
            "arc.prev_mirror_snapshot": {
                "revision": 3,
                "bufferStartIndex": prev_start,
                "bufferLines": prev_lines.iter().map(|text| line(text)).collect::<Vec<_>>(),
            },
            "arc.subscriber_facts": subscribers,
        }
    })
}

fn output_frames(body: &serde_json::Value) -> &serde_json::Value {
    body.get("outputs")
        .unwrap()
        .get("arc.wire_frames")
        .unwrap()
        .get("frames")
        .unwrap()
}

#[test]
fn compiles_phase0_graphs() {
    assert!(zterm_dagpipe::core::compile_phase0_graphs().is_ok());
}

#[test]
fn buffer_growth_emits_append_tail_no_hole() {
    let request = mirror_request(
        0,
        &["a", "b"],
        0,
        &["a", "b", "c"],
        json!({}),
        json!({ "availableStartIndex": 0, "availableEndIndex": 3 }),
    );
    let result =
        zterm_dagpipe::core::run_mirror_publish_json(serde_json::to_string(&request).unwrap())
            .unwrap();
    assert_eq!(result["ok"], true);
    let frames = output_frames(&result);
    assert_eq!(frames[0]["action"], "body");
    assert_eq!(frames[0]["changeKind"], "append");
    assert_eq!(frames[0]["ranges"][0]["startIndex"], 2);
    assert_eq!(frames[0]["ranges"][0]["endIndex"], 3);
}

#[test]
fn old_line_rewrite_emits_rewritten_span() {
    let request = mirror_request(
        0,
        &["a", "b", "c"],
        0,
        &["a", "X", "c"],
        json!({}),
        json!({ "availableStartIndex": 0, "availableEndIndex": 3 }),
    );
    let result =
        zterm_dagpipe::core::run_mirror_publish_json(serde_json::to_string(&request).unwrap())
            .unwrap();
    assert_eq!(result["ok"], true);
    let frames = output_frames(&result);
    assert_eq!(frames[0]["changeKind"], "rewrite");
    assert_eq!(frames[0]["ranges"][0]["startIndex"], 1);
    assert_eq!(frames[0]["ranges"][0]["endIndex"], 2);
}

#[test]
fn spaced_changes_collapse_to_no_hole_refresh_span() {
    let request = mirror_request(
        0,
        &["a", "b", "c"],
        0,
        &["a", "Y", "Z"],
        json!({}),
        json!({ "availableStartIndex": 0, "availableEndIndex": 3 }),
    );
    let result =
        zterm_dagpipe::core::run_mirror_publish_json(serde_json::to_string(&request).unwrap())
            .unwrap();
    let frames = output_frames(&result);
    assert_eq!(frames[0]["ranges"], json!([{"startIndex":1,"endIndex":3}]));
}

#[test]
fn unchanged_body_emits_head_only() {
    let request = mirror_request(
        0,
        &["a", "b"],
        0,
        &["a", "b"],
        json!({}),
        json!({ "availableStartIndex": 0, "availableEndIndex": 2 }),
    );
    let result =
        zterm_dagpipe::core::run_mirror_publish_json(serde_json::to_string(&request).unwrap())
            .unwrap();
    let frames = output_frames(&result);
    assert_eq!(frames[0]["kind"], "head");
    assert_eq!(frames[0]["action"], "head-only");
    assert_eq!(frames[0]["ranges"], json!([]));
}

#[test]
fn pending_bounds_escalate_to_full_resync() {
    let request = mirror_request(
        0,
        &["a", "b"],
        0,
        &["a", "b", "c"],
        json!({ "maxPendingRanges": 0 }),
        json!({
            "availableStartIndex": 0,
            "availableEndIndex": 3,
            "subscribers": [{
                "id": "s1",
                "pendingRanges": [{ "startIndex": 0, "endIndex": 1 }],
            }]
        }),
    );
    let result =
        zterm_dagpipe::core::run_mirror_publish_json(serde_json::to_string(&request).unwrap())
            .unwrap();
    let frames = output_frames(&result);
    assert_eq!(frames[0]["fullResync"], true);
    assert_eq!(frames[0]["ranges"], json!([{"startIndex":0,"endIndex":3}]));
}

#[test]
fn backpressured_subscriber_holds() {
    let request = mirror_request(
        0,
        &["a", "b"],
        0,
        &["a", "b", "c"],
        json!({}),
        json!({
            "availableStartIndex": 0,
            "availableEndIndex": 3,
            "subscribers": [{
                "id": "s1",
                "backpressure": true,
            }]
        }),
    );
    let result =
        zterm_dagpipe::core::run_mirror_publish_json(serde_json::to_string(&request).unwrap())
            .unwrap();
    let frames = output_frames(&result);
    assert_eq!(frames[0]["action"], "hold");
    assert_eq!(frames[0]["kind"], "hold");
}

#[test]
fn invalid_control_produces_explicit_failure() {
    let request = json!({
        "execution_id": "phase0-control",
        "attempt_id": "1",
        "inputs": {
            "arc.control_ingress": {
                "commandId": "c1",
                "correlationId": "c1",
                "commandType": "schedule-list",
            },
            "arc.capability_policy": {
                "ownerByCommand": {
                    "schedule-list": "daemon.control_center:schedule-list"
                }
            }
        }
    });
    let result =
        zterm_dagpipe::core::run_control_dispatch_json(serde_json::to_string(&request).unwrap())
            .unwrap();
    assert_eq!(result["ok"], false);
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("missing subject"));
}
