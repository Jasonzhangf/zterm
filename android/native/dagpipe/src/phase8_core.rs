//! DAGpipe Phase 8 operators for the Android connection service surface.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const CONNECTION_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-connection-service.graph.json");

pub const CONNECTION_GRAPH_ID: &str = "android.connection_service";
pub const PHASE8_GRAPH_VERSION: &str = "0.1";

fn obj(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn inputs(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        other => vec![other],
    }
}

fn get_str<'a>(object: &'a Map<String, Value>, key: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or("")
}

fn get_bool(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn get_obj(object: &Map<String, Value>, key: &str) -> Map<String, Value> {
    object
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn get_array(object: &Map<String, Value>, key: &str) -> Vec<Value> {
    object
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn command_type(command: &Map<String, Value>) -> String {
    let ty = get_str(command, "type");
    if ty.is_empty() {
        get_str(command, "command").to_string()
    } else {
        ty.to_string()
    }
}

struct ServiceCommandGate;

impl Operator for ServiceCommandGate {
    fn name(&self) -> &'static str {
        "client.connection_service.validate_command"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let command = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let cmd = command_type(&command);
        if cmd.is_empty() {
            return Err("service command rejected: missing type".into());
        }
        let allowed = ["bind-target", "release-target"];
        if !allowed.contains(&cmd.as_str()) {
            return Err(format!("service command rejected: {cmd}"));
        }
        let mut gate = Map::new();
        gate.insert("command".to_string(), json!(cmd));
        gate.insert("allowed".to_string(), json!(true));
        if let Some(target) = command.get("target") {
            gate.insert("target".to_string(), target.clone());
        }
        if let Some(policy_command) = command.get("policy") {
            gate.insert("policy".to_string(), policy_command.clone());
        }
        let _ = policy;
        Ok(Value::Object(gate))
    }
}

struct BindDesiredTarget;

impl Operator for BindDesiredTarget {
    fn name(&self) -> &'static str {
        "client.connection_service.bind_target"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let gate = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        if command_type(&gate) != "bind-target" {
            return Ok(json!({
                "state": "no-bind",
                "targetKey": "",
            }));
        }
        let target = get_obj(&gate, "target");
        if get_str(&target, "targetKey").is_empty() {
            return Err("bind target requires targetKey".into());
        }
        let mut desired = target.clone();
        desired.insert("state".to_string(), json!("desired"));
        desired.insert(
            "channelCount".to_string(),
            json!(get_array(&target, "channels").len()),
        );
        let _ = policy;
        Ok(json!(desired))
    }
}

struct ReleaseDesiredTarget;

impl Operator for ReleaseDesiredTarget {
    fn name(&self) -> &'static str {
        "client.connection_service.release_target"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let gate = obj(inputs(input).first().cloned().unwrap_or_default());
        if command_type(&gate) != "release-target" {
            return Ok(json!({
                "state": "no-release",
                "reason": Value::Null,
            }));
        }
        Ok(json!({
            "state": "release-planned",
            "reason": get_str(&gate, "reason"),
        }))
    }
}

struct NetworkGenerationValidate;

impl Operator for NetworkGenerationValidate {
    fn name(&self) -> &'static str {
        "client.android_connection_service.validate_network_generation"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let event = obj(values.first().cloned().unwrap_or_default());
        let desired = obj(values.get(1).cloned().unwrap_or_default());
        if get_str(&desired, "state") == "no-bind" {
            return Ok(json!({
                "state": "no-network",
                "generation": Value::Null,
                "targetKey": "",
            }));
        }
        if get_str(&desired, "targetKey").is_empty() && get_str(&event, "targetKey").is_empty() {
            return Ok(json!({
                "state": "no-network",
                "generation": Value::Null,
                "targetKey": "",
            }));
        }
        if get_bool(&event, "stale") {
            return Err("stale network generation rejected".into());
        }
        Ok(json!({
            "state": "network-valid",
            "generation": get_str(&event, "generation"),
            "targetKey": get_str(&desired, "targetKey").to_string(),
        }))
    }
}

struct ReplayDesiredChannels;

impl Operator for ReplayDesiredChannels {
    fn name(&self) -> &'static str {
        "client.android_connection_service.replay_desired_channels"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let desired = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        if get_str(&desired, "state") != "desired" {
            return Ok(json!({
                "state": "no-replay",
                "targetKey": "",
                "channels": json!([]),
                "channelCount": 0,
            }));
        }
        let max_channels = policy
            .get("maxReplayChannels")
            .and_then(Value::as_u64)
            .unwrap_or(3) as usize;
        let channels = get_array(&desired, "channels")
            .into_iter()
            .take(max_channels)
            .collect::<Vec<_>>();
        Ok(json!({
            "targetKey": get_str(&desired, "targetKey"),
            "state": "replay-planned",
            "channels": channels,
            "channelCount": channels.len(),
        }))
    }
}

struct EstablishPhysicalTransport;

impl Operator for EstablishPhysicalTransport {
    fn name(&self) -> &'static str {
        "client.android_connection_service.establish_transport"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let generation = obj(values.first().cloned().unwrap_or_default());
        let replay = obj(values.get(1).cloned().unwrap_or_default());
        let policy = obj(values.get(2).cloned().unwrap_or_default());
        if get_str(&replay, "targetKey").is_empty() {
            return Ok(json!({
                "state": "no-transport",
                "targetKey": "",
                "generation": Value::Null,
                "channels": json!([]),
                "channelCount": 0,
            }));
        }
        if !get_bool(&policy, "allowTransport") && policy.contains_key("allowTransport") {
            return Err("physical transport blocked by policy".into());
        }
        Ok(json!({
            "targetKey": get_str(&replay, "targetKey"),
             "generation": get_str(&generation, "generation"),
            "state": "connected",
            "channels": get_array(&replay, "channels"),
            "channelCount": get_array(&replay, "channels").len(),
        }))
    }
}

struct MaintainHeartbeat;

impl Operator for MaintainHeartbeat {
    fn name(&self) -> &'static str {
        "client.android_connection_service.maintain_heartbeat"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let transport = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        if get_str(&transport, "state") != "connected" {
            return Ok(json!({
                "state": "no-health",
                "misses": 0,
                "target": "",
            }));
        }
        if get_bool(&policy, "simulateHeartbeatMiss") {
            return Ok(json!({
                "state": "recoverable",
                "misses": 1,
                "target": get_str(&transport, "targetKey"),
            }));
        }
        Ok(json!({
            "state": "healthy",
            "misses": 0,
            "target": get_str(&transport, "targetKey"),
        }))
    }
}

struct ScheduleBackoffReconnect;

impl Operator for ScheduleBackoffReconnect {
    fn name(&self) -> &'static str {
        "client.android_connection_service.schedule_backoff_reconnect"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let health = obj(values.first().cloned().unwrap_or_default());
        let desired = obj(values.get(1).cloned().unwrap_or_default());
        let policy = obj(values.get(2).cloned().unwrap_or_default());
        if get_str(&desired, "state") == "no-bind" || get_str(&desired, "targetKey").is_empty() {
            return Ok(json!({
                "state": "no-backoff",
                "target": "",
            }));
        }
        if get_str(&health, "state") == "healthy" {
            return Ok(json!({
                "state": "no-backoff",
                "target": get_str(&desired, "targetKey"),
            }));
        }
        if !get_bool(&policy, "allowReconnect") && policy.contains_key("allowReconnect") {
            return Err("reconnect disabled by policy".into());
        }
        Ok(json!({
            "state": "backoff-scheduled",
            "target": get_str(&desired, "targetKey"),
        }))
    }
}

struct ProjectServiceSnapshot;

impl Operator for ProjectServiceSnapshot {
    fn name(&self) -> &'static str {
        "client.connection_service.project_snapshot"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let desired = obj(values.first().cloned().unwrap_or_default());
        let release = obj(values.get(1).cloned().unwrap_or_default());
        let transport = obj(values.get(2).cloned().unwrap_or_default());
        let health = obj(values.get(3).cloned().unwrap_or_default());
        let backoff = obj(values.get(4).cloned().unwrap_or_default());
        if get_str(&desired, "state") == "no-bind"
            || get_str(&release, "state") == "release-planned"
        {
            return Ok(json!({
                "state": "idle",
                "generation": Value::Null,
                "channels": json!([]),
            }));
        }
        let state = if get_str(&health, "state") == "healthy" {
            "healthy"
        } else if get_str(&backoff, "state").starts_with("backoff") {
            "backoff-reconnect"
        } else if !get_str(&transport, "state").is_empty() {
            "connected"
        } else {
            "resolving-target"
        };
        Ok(json!({
            "state": state,
            "target": get_str(&desired, "targetKey"),
            "generation": get_str(&transport, "generation"),
            "channels": get_array(&transport, "channels"),
        }))
    }
}

struct ProjectNotificationActions;

impl Operator for ProjectNotificationActions {
    fn name(&self) -> &'static str {
        "client.android_notification_sessions.project_actions"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let transport = obj(values.first().cloned().unwrap_or_default());
        let snapshot = obj(values.get(1).cloned().unwrap_or_default());
        let policy = obj(values.get(2).cloned().unwrap_or_default());
        if !get_bool(&policy, "allowNotifications") && policy.contains_key("allowNotifications") {
            return Ok(json!({ "actions": json!([]) }));
        }
        let max_actions = policy
            .get("maxNotificationActions")
            .and_then(Value::as_u64)
            .unwrap_or(3) as usize;
        let mut seen = std::collections::BTreeSet::new();
        let mut actions = vec![];
        let target_key = get_str(&transport, "targetKey");
        for channel in get_array(&snapshot, "channels") {
            if actions.len() >= max_actions {
                break;
            }
            let channel = obj(channel);
            if get_str(&channel, "state") == "open" {
                let channel_id = get_str(&channel, "channelId");
                let identity = format!("{target_key}:{channel_id}");
                if !seen.insert(identity) {
                    continue;
                }
                actions.push(json!({
                    "targetKey": target_key,
                    "channelId": channel_id,
                    "sessionName": get_str(&channel, "sessionName"),
                    "state": "open",
                }));
            }
        }
        Ok(json!({
            "actions": json!(actions),
            "maxActions": max_actions,
        }))
    }
}

struct HandleSessionDeepLink;

impl Operator for HandleSessionDeepLink {
    fn name(&self) -> &'static str {
        "client.android_notification_sessions.open_session_deep_link"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let action = obj(values.first().cloned().unwrap_or_default());
        let actions = obj(values.get(1).cloned().unwrap_or_default());
        let actions = get_array(&actions, "actions");
        let target = get_str(&action, "targetKey");
        let channel = get_str(&action, "channelId");
        let session = get_str(&action, "sessionName");
        if target.is_empty() || channel.is_empty() || session.is_empty() {
            return Ok(json!({
                "state": "idle",
                "targetKey": "",
                "channelId": "",
                "sessionName": "",
            }));
        }
        let matched = actions.iter().any(|candidate| {
            let candidate = obj(candidate.clone());
            get_str(&candidate, "targetKey") == target
                && get_str(&candidate, "channelId") == channel
                && get_str(&candidate, "state") == "open"
        });
        if !matched {
            return Ok(json!({
                "state": "idle",
                "targetKey": "",
                "channelId": "",
                "sessionName": "",
            }));
        }
        Ok(json!({
            "targetKey": target,
            "channelId": channel,
            "sessionName": session,
            "state": "session-open-deep-link-ready",
        }))
    }
}

struct PulseStoppedSession;

impl Operator for PulseStoppedSession {
    fn name(&self) -> &'static str {
        "client.android_notification_sessions.pulse_stopped"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let fact = obj(values.first().cloned().unwrap_or_default());
        let actions = obj(values.get(1).cloned().unwrap_or_default());
        let policy = obj(values.get(2).cloned().unwrap_or_default());
        if !get_bool(&fact, "stopped") {
            return Ok(json!({
                "pulse": false,
                "reason": "not-stopped",
                "sessionName": get_str(&fact, "name"),
            }));
        }
        let session = get_str(&fact, "name");
        let target = get_str(&fact, "targetKey");
        let channel = get_str(&fact, "channelId");
        let matched = get_array(&actions, "actions").iter().any(|candidate| {
            let candidate = obj(candidate.clone());
            get_str(&candidate, "sessionName") == session
                && (target.is_empty() || get_str(&candidate, "targetKey") == target)
                && (channel.is_empty() || get_str(&candidate, "channelId") == channel)
        });
        if !matched {
            return Ok(json!({
                "pulse": false,
                "reason": "unmatched",
                "targetKey": target,
                "channelId": channel,
                "sessionName": session,
            }));
        }
        let _ = policy;
        Ok(json!({
            "pulse": true,
            "targetKey": target,
            "channelId": channel,
            "sessionName": session,
        }))
    }
}

fn make_registry() -> Registry {
    let mut registry = Registry::default();
    macro_rules! register {
        ($op:expr) => {
            registry.register($op).expect("register operator")
        };
    }
    register!(ServiceCommandGate);
    register!(BindDesiredTarget);
    register!(ReleaseDesiredTarget);
    register!(NetworkGenerationValidate);
    register!(ReplayDesiredChannels);
    register!(EstablishPhysicalTransport);
    register!(MaintainHeartbeat);
    register!(ScheduleBackoffReconnect);
    register!(ProjectServiceSnapshot);
    register!(ProjectNotificationActions);
    register!(HandleSessionDeepLink);
    register!(PulseStoppedSession);
    crate::sese_core::register_sese_operators(&mut registry);
    registry
}

fn run_graph(request: Value, graph_json: &str, graph_id: &str) -> serde_json::Result<Value> {
    let request_obj = match request {
        Value::Object(map) => map,
        other => obj(other),
    };
    let execution_id = get_str(&request_obj, "execution_id").to_string();
    let attempt_id = get_str(&request_obj, "attempt_id").to_string();
    let mut inputs_map = request_obj
        .get("inputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<HashMap<String, Value>>();
    if let Ok(graph_value) = serde_json::from_str::<Value>(graph_json) {
        crate::sese_core::wrap_request_inputs(&graph_value, &mut inputs_map);
    }
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    let compiled = match parse_graph_json(graph_json)
        .and_then(|graph| compile(graph, &registry, &capabilities))
    {
        Ok(compiled) => compiled,
        Err(error) => {
            return Ok(json!({ "ok": false, "error": error.message }));
        }
    };
    let identity = Identity {
        project_id: "zterm".into(),
        graph_id: graph_id.into(),
        graph_version: PHASE8_GRAPH_VERSION.into(),
        execution_id: if execution_id.is_empty() {
            "execution".into()
        } else {
            execution_id
        },
        attempt_id: if attempt_id.is_empty() {
            "attempt".into()
        } else {
            attempt_id
        },
    };
    let runtime = Runtime::new(capabilities);
    match runtime.run(&compiled, identity, inputs_map, &Cancellation::default()) {
        Ok(result) => {
            let mut outputs = serde_json::Map::new();
            for (arc_id, arc) in crate::sese_core::unwrap_result_outputs(&result.outputs) {
                outputs.insert(arc_id, arc.payload.clone());
            }
            Ok(json!({ "ok": true, "outputs": Value::Object(outputs) }))
        }
        Err(failure) => Ok(json!({
            "ok": false,
            "error": failure.error.message,
        })),
    }
}

pub fn compile_phase8_graphs() -> Result<Vec<String>, CompileError> {
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    compile(
        parse_graph_json(CONNECTION_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    Ok(vec![format!(
        "{CONNECTION_GRAPH_ID}@{PHASE8_GRAPH_VERSION}"
    )])
}

pub fn run_phase8_connection_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        CONNECTION_GRAPH_JSON,
        CONNECTION_GRAPH_ID,
    )
}
