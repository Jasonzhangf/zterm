use serde_json::{json, Value};

fn run_remote_window(input: Value) -> Value {
    zterm_dagpipe::phase4_core::run_phase4_remote_window_json(
        serde_json::to_string(&input).unwrap(),
    )
    .unwrap()
}

#[test]
fn compiles_phase4_graph() {
    let graphs = zterm_dagpipe::phase4_core::compile_phase4_graphs().unwrap();
    assert_eq!(graphs, vec!["remote.window_stream_overlay@0.1"]);
}

#[test]
fn remote_window_overlay_projects_directory_video_and_injected_input() {
    let result = run_remote_window(json!({
        "execution_id": "phase4-stream",
        "attempt_id": "1",
        "inputs": {
            "arc.catalog_request": {
                "requestId": "c1",
                "windows": [{ "id": "w1", "name": "Terminal" }],
            },
            "arc.stream_start_intent": { "requestId": "s1", "targetId": "w1" },
            "arc.touch_action": { "kind": "tap", "x": 10, "y": 20 },
            "arc.quality_intent": { "targetId": "w1", "mode": "balanced" },
            "arc.stream_policy": { "allowStream": true, "allowQuality": true, "fps": 30 },
        },
    }));
    assert_eq!(result["ok"], true, "phase4 stream failed: {result}");
    let outputs = &result["outputs"];
    assert_eq!(outputs["arc.overlay_directory"]["state"], "ready");
    assert_eq!(outputs["arc.overlay_projection"]["state"], "projected");
    assert_eq!(outputs["arc.input_result"]["state"], "injected");
}

#[test]
fn remote_window_rejects_empty_catalog() {
    let result = run_remote_window(json!({
        "execution_id": "phase4-empty-catalog",
        "attempt_id": "1",
        "inputs": {
            "arc.catalog_request": { "requestId": "c1" },
            "arc.stream_start_intent": { "targetId": "w1" },
            "arc.touch_action": { "kind": "tap" },
            "arc.quality_intent": { "targetId": "w1" },
            "arc.stream_policy": {},
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn remote_window_rejects_unknown_stream_target() {
    let result = run_remote_window(json!({
        "execution_id": "phase4-unknown-target",
        "attempt_id": "1",
        "inputs": {
            "arc.catalog_request": {
                "requestId": "c1",
                "windows": [{ "id": "w1", "name": "Terminal" }],
            },
            "arc.stream_start_intent": { "requestId": "s1", "targetId": "missing" },
            "arc.touch_action": { "kind": "tap" },
            "arc.quality_intent": { "targetId": "missing" },
            "arc.stream_policy": { "allowStream": true, "allowQuality": true },
        },
    }));
    assert_eq!(result["ok"], false);
}
