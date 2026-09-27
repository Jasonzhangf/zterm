use serde_json::json;

fn run_relay(input: serde_json::Value) -> serde_json::Value {
    zterm_dagpipe::phase2_core::run_phase2_relay_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_daemon_connection(input: serde_json::Value) -> serde_json::Value {
    zterm_dagpipe::phase2_core::run_phase2_daemon_connection_json(
        serde_json::to_string(&input).unwrap(),
    )
    .unwrap()
}

fn daemon_request_with_channels(
    channels: serde_json::Value,
    channel_removal: serde_json::Value,
) -> serde_json::Value {
    json!({
        "execution_id": "phase2-daemon",
        "attempt_id": "1",
        "inputs": {
            "arc.physical_connection": {
                "connectionId": "conn-1",
                "channels": channels,
            },
            "arc.mux_capabilities": { "muxEnabled": true },
            "arc.session_catalog_request": { "sessionNames": [{ "sessionId": "s1" }] },
            "arc.idle_facts_request": {},
            "arc.channel_removal_request": channel_removal,
        }
    })
}

fn daemon_request(channel_removal: serde_json::Value) -> serde_json::Value {
    daemon_request_with_channels(
        json!([{ "channelId": "s1", "sessionName": "s1" }]),
        channel_removal,
    )
}

#[test]
fn compiles_phase2_graphs() {
    let graphs = zterm_dagpipe::phase2_core::compile_phase2_graphs().unwrap();
    assert_eq!(
        graphs,
        vec![
            "relay.account_peer_route@0.1",
            "daemon.connection_channel_catalog@0.1",
        ]
    );
}

#[test]
fn relay_route_resumes_bound_target() {
    let request = json!({
        "execution_id": "phase2-relay",
        "attempt_id": "1",
        "inputs": {
            "arc.account_credentials": { "accountId": "u1", "authToken": "tok" },
            "arc.relay_settings": { "relayEnabled": true },
            "arc.device_capabilities": {
                "deviceId": "device-a",
                "platform": "android",
                "routes": ["relay"]
            },
            "arc.route_policy": { "pathPriority": ["relay"] }
        }
    });
    let result = run_relay(request);
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.account_directory"]["state"], "ready");
    assert_eq!(
        result["outputs"]["arc.validated_lease"]["state"],
        "validated"
    );
    assert_eq!(result["outputs"]["arc.resume_plan"]["state"], "ready");
    assert_eq!(result["outputs"]["arc.resume_plan"]["action"], "resume");
}

#[test]
fn relay_missing_credentials_fails_explicitly() {
    let request = json!({
        "execution_id": "phase2-relay-fail",
        "attempt_id": "1",
        "inputs": {
            "arc.account_credentials": {},
            "arc.relay_settings": { "relayEnabled": true },
            "arc.device_capabilities": { "deviceId": "device-a" },
            "arc.route_policy": { "pathPriority": ["relay"] }
        }
    });
    let result = run_relay(request);
    assert_eq!(result["ok"], false);
    assert!(result["error"]
        .as_str()
        .unwrap_or("")
        .contains("relay login"));
}

#[test]
fn daemon_connection_builds_catalog_and_publishes_idle_facts() {
    let result = run_daemon_connection(daemon_request(json!({ "removedChannelId": "s1" })));
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.session_catalog"]["state"], "ready");
    assert_eq!(result["outputs"]["arc.idle_facts"]["state"], "published");
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["state"],
        "released"
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["removedChannelId"],
        "s1"
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["channels"],
        serde_json::Value::Array(vec![])
    );
}

#[test]
fn daemon_connection_requires_mux_enabled() {
    let mut request = daemon_request(json!({ "removedChannelId": "s1" }));
    request["inputs"]["arc.mux_capabilities"] = json!({ "muxEnabled": false });
    let result = run_daemon_connection(request);
    assert_eq!(result["ok"], false);
    assert!(result["error"]
        .as_str()
        .unwrap_or("")
        .contains("muxEnabled"));
}

#[test]
fn daemon_connection_without_removal_is_explicit_noop() {
    let result = run_daemon_connection(daemon_request(json!({})));
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["state"],
        "not-requested"
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["removedChannelId"],
        serde_json::Value::Null
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["channels"],
        json!([{ "channelId": "s1", "sessionName": "s1" }])
    );
}

#[test]
fn daemon_connection_rejects_unregistered_channel_removal() {
    let result = run_daemon_connection(daemon_request(json!({ "removedChannelId": "missing" })));
    assert_eq!(result["ok"], false);
    assert!(result["error"]
        .as_str()
        .unwrap_or("")
        .contains("not registered"));
}

#[test]
fn daemon_connection_rejects_channel_id_fallback() {
    let result = run_daemon_connection(daemon_request(json!({ "channelId": "s1" })));
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["state"],
        "not-requested"
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["removedChannelId"],
        serde_json::Value::Null
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["channels"],
        json!([{ "channelId": "s1", "sessionName": "s1" }])
    );
}

#[test]
fn daemon_connection_release_keeps_sibling_channel_subscribed() {
    let result = run_daemon_connection(daemon_request_with_channels(
        json!([
            { "channelId": "s1", "sessionName": "s1" },
            { "channelId": "s2", "sessionName": "s2" },
        ]),
        json!({ "removedChannelId": "s1" }),
    ));
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["state"],
        "released"
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["removedChannelId"],
        "s1"
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["bodySubscribed"],
        true
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["bodySubscribedByChannel"]["s2"],
        true
    );
    assert!(
        result["outputs"]["arc.subscriber_released"]["bodySubscribedByChannel"]
            .get("s1")
            .is_none()
    );
    assert_eq!(
        result["outputs"]["arc.subscriber_released"]["channels"],
        json!([{ "channelId": "s2", "sessionName": "s2" }])
    );
}
