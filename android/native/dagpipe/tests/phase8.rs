use serde_json::{json, Value};

fn run_connection(input: Value) -> Value {
    zterm_dagpipe::phase8_core::run_phase8_connection_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

#[test]
fn compiles_all_dagpipe_phases() {
    let graphs = zterm_dagpipe::compile_all_dagpipe_phases().unwrap();
    assert!(
        graphs.len() >= 25,
        "expected all phase graphs, got {}",
        graphs.len()
    );
    assert!(graphs
        .iter()
        .any(|id| id == "android.connection_service@0.1"));
}

fn bind_input(
    target: Value,
    generation: Value,
    notification_action: Value,
    session_fact: Value,
) -> Value {
    json!({
        "execution_id": "phase8-connection",
        "attempt_id": "1",
        "inputs": {
            "arc.service_command": {
                "type": "bind-target",
                "target": target,
            },
            "arc.service_policy": {
                "allowTransport": true,
                "allowReconnect": true,
                "allowNotifications": true,
                "maxNotificationActions": 3,
                "maxReplayChannels": 3,
            },
            "arc.network_generation_event": generation,
            "arc.notification_action": notification_action,
            "arc.session_activity_fact": session_fact,
        },
    })
}

#[test]
fn compiles_phase8_graph() {
    let graphs = zterm_dagpipe::phase8_core::compile_phase8_graphs().unwrap();
    assert_eq!(graphs, vec!["android.connection_service@0.1"]);
}

#[test]
fn connection_service_binds_healthy_projects_and_pulses() {
    let result = run_connection(bind_input(
        json!({
            "targetKey": "t1",
            "bridgeHost": "host-1",
            "channels": [
                { "channelId": "c1", "sessionName": "s1", "state": "open" },
            ],
        }),
        json!({ "generation": "g1" }),
        json!({ "targetKey": "t1", "channelId": "c1", "sessionName": "s1" }),
        json!({ "stopped": true, "name": "s1", "targetKey": "t1", "channelId": "c1" }),
    ));
    assert_eq!(result["ok"], true, "phase8 connection failed: {result}");
    assert_eq!(
        result["outputs"]["arc.service_snapshot"]["state"],
        "healthy"
    );
    assert_eq!(
        result["outputs"]["arc.notification_actions"]["actions"][0]["channelId"],
        "c1"
    );
    assert_eq!(
        result["outputs"]["arc.session_open_request"]["state"],
        "session-open-deep-link-ready"
    );
    assert_eq!(result["outputs"]["arc.notification_pulse"]["pulse"], true);
}

#[test]
fn rejects_stale_network_generation() {
    let result = run_connection(bind_input(
        json!({
            "targetKey": "t1",
            "bridgeHost": "host-1",
            "channels": [],
        }),
        json!({ "generation": "g-old", "stale": true }),
        json!({}),
        json!({}),
    ));
    assert_eq!(result["ok"], false);
}

#[test]
fn rejects_invalid_service_command() {
    let result = run_connection(json!({
        "execution_id": "phase8-connection-invalid",
        "attempt_id": "1",
        "inputs": {
            "arc.service_command": { "type": "foreground-resume" },
            "arc.service_policy": {
                "allowTransport": true,
                "allowReconnect": true,
                "allowNotifications": true,
            },
            "arc.network_generation_event": { "generation": "g1" },
            "arc.notification_action": {},
            "arc.session_activity_fact": {},
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn notification_deep_link_for_unknown_channel_remains_idle() {
    let result = run_connection(bind_input(
        json!({
            "targetKey": "t1",
            "bridgeHost": "host-1",
            "channels": [
                { "channelId": "c1", "sessionName": "s1", "state": "open" },
            ],
        }),
        json!({ "generation": "g1" }),
        json!({ "targetKey": "t1", "channelId": "missing", "sessionName": "s1" }),
        json!({ "stopped": true, "name": "s1", "targetKey": "t1", "channelId": "c1" }),
    ));
    assert_eq!(
        result["ok"], true,
        "phase8 unknown deep link failed: {result}"
    );
    assert_eq!(
        result["outputs"]["arc.session_open_request"]["state"],
        "idle"
    );
}

#[test]
fn stopped_pulse_without_matching_action_is_unmatched() {
    let result = run_connection(bind_input(
        json!({
            "targetKey": "t1",
            "bridgeHost": "host-1",
            "channels": [
                { "channelId": "c1", "sessionName": "s1", "state": "open" },
            ],
        }),
        json!({ "generation": "g1" }),
        json!({ "targetKey": "t1", "channelId": "c1", "sessionName": "s1" }),
        json!({ "stopped": true, "name": "other-session" }),
    ));
    assert_eq!(
        result["ok"], true,
        "phase8 unmatched pulse failed: {result}"
    );
    assert_eq!(result["outputs"]["arc.notification_pulse"]["pulse"], false);
}

#[test]
fn release_target_projects_idle_snapshot() {
    let result = run_connection(json!({
        "execution_id": "phase8-release",
        "attempt_id": "1",
        "inputs": {
            "arc.service_command": {
                "type": "release-target",
                "reason": "user",
            },
            "arc.service_policy": {
                "allowTransport": true,
                "allowReconnect": true,
                "allowNotifications": true,
            },
            "arc.network_generation_event": { "generation": "g1" },
            "arc.notification_action": {},
            "arc.session_activity_fact": {},
        },
    }));
    assert_eq!(result["ok"], true, "phase8 release failed: {result}");
    assert_eq!(result["outputs"]["arc.service_snapshot"]["state"], "idle");
}
