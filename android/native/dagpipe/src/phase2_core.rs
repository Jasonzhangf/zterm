//! DAGpipe Phase 2 operators for Relay peer routing and daemon connection
//! channel catalog. These operators stay pure projections: they only consume
//! ARC values and never access transport, session, or UI truth.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const RELAY_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/relay-account-peer-route.graph.json");
const DAEMON_CONNECTION_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-connection-channel-catalog.graph.json");

pub const RELAY_GRAPH_ID: &str = "relay.account_peer_route";
pub const DAEMON_CONNECTION_CATALOG_GRAPH_ID: &str = "daemon.connection_channel_catalog";
pub const PHASE2_GRAPH_VERSION: &str = "0.1";

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

fn subscription_map(channels: &Value) -> Map<String, Value> {
    let mut map = Map::new();
    if let Some(items) = channels.as_array() {
        for channel in items {
            if let Some(channel_id) = channel.get("channelId").and_then(Value::as_str) {
                map.insert(channel_id.to_string(), Value::Bool(true));
            }
        }
    }
    map
}

fn array_of_strings(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn make_registry() -> Registry {
    let mut registry = Registry::default();
    macro_rules! register {
        ($op:expr) => {
            registry.register($op).expect("register operator")
        };
    }
    // relay.account_peer_route uses the shared client.relay_account owner from
    // core.rs; the old duplicated relay.account_directory operators are gone.
    register!(crate::core::RelayAccountLogin);
    register!(crate::core::RelayAccountPublishDevice);
    register!(RelayProjectDirectory);
    register!(RelayResolveRoutes);
    register!(RelayIssueLease);
    register!(RelayValidateLease);
    register!(RelayBindTarget);
    register!(RelayResumeTarget);
    // daemon.connection_channel_catalog
    register!(DaemonAcceptConnection);
    register!(DaemonNegotiateMux);
    register!(DaemonRegisterChannel);
    register!(DaemonBindBodySubscription);
    register!(DaemonBuildSessionCatalog);
    register!(DaemonPublishIdleFacts);
    register!(DaemonUnregisterChannel);
    register!(DaemonReleaseBodySubscription);
    register!(DaemonReconcileBodySubscription);
    register!(DaemonSettlePhysicalSubscriber);
    crate::sese_core::register_sese_operators(&mut registry);
    registry
}

fn run_graph(
    request: Value,
    graph_json: &str,
    graph_id: &str,
    graph_version: &str,
) -> serde_json::Result<Value> {
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
        graph_version: graph_version.into(),
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

pub fn compile_phase2_graphs() -> Result<Vec<String>, CompileError> {
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    compile(
        parse_graph_json(RELAY_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    compile(
        parse_graph_json(DAEMON_CONNECTION_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    Ok(vec![
        format!("{RELAY_GRAPH_ID}@{PHASE2_GRAPH_VERSION}"),
        format!("{DAEMON_CONNECTION_CATALOG_GRAPH_ID}@{PHASE2_GRAPH_VERSION}"),
    ])
}

pub fn run_phase2_relay_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        RELAY_GRAPH_JSON,
        RELAY_GRAPH_ID,
        PHASE2_GRAPH_VERSION,
    )
}

pub fn run_phase2_daemon_connection_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        DAEMON_CONNECTION_GRAPH_JSON,
        DAEMON_CONNECTION_CATALOG_GRAPH_ID,
        PHASE2_GRAPH_VERSION,
    )
}

struct RelayProjectDirectory;

impl Operator for RelayProjectDirectory {
    fn name(&self) -> &'static str {
        "relay.account_directory.project"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let session = obj(values.first().cloned().unwrap_or_default());
        let device = obj(values.get(1).cloned().unwrap_or_default());
        Ok(json!({
            "accountId": get_str(&session, "accountId"),
            "devices": vec![device],
            "state": "ready",
        }))
    }
}

struct RelayResolveRoutes;

impl Operator for RelayResolveRoutes {
    fn name(&self) -> &'static str {
        "relay.route_selection.resolve"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let directory = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let raw_candidates = directory
            .get("devices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let path_priority = array_of_strings(policy.get("pathPriority"));
        let selected = path_priority
            .into_iter()
            .filter(|candidate| candidate.as_str() != Some("auth-failure"))
            .find(|candidate| {
                candidate
                    .as_str()
                    .map(|candidate_id| {
                        raw_candidates.iter().any(|raw| {
                            raw.get("routes")
                                .and_then(Value::as_array)
                                .map(|routes| {
                                    routes
                                        .iter()
                                        .any(|route| route.as_str() == Some(candidate_id))
                                })
                                .unwrap_or(false)
                                && raw.get("state").and_then(Value::as_str) == Some("published")
                        })
                    })
                    .unwrap_or(false)
            })
            .unwrap_or(Value::Null);
        Ok(json!({
            "candidates": raw_candidates,
            "selected": selected,
            "state": if selected.as_str().is_none_or(|s| s.is_empty()) {
                "no-route"
            } else {
                "ready"
            },
        }))
    }
}

struct RelayIssueLease;

impl Operator for RelayIssueLease {
    fn name(&self) -> &'static str {
        "relay.peer_lease.issue"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let route_plan = obj(values.first().cloned().unwrap_or_default());
        let device = obj(values.get(1).cloned().unwrap_or_default());
        let target_key = get_str(&route_plan, "selected").to_string();
        if target_key.is_empty() {
            return Err("peer lease requires a selected route".into());
        }
        Ok(json!({
            "leaseId": format!("lease-{}", get_str(&device, "deviceId")),
            "accountId": get_str(&device, "accountId"),
            "targetKey": target_key,
            "state": "issued",
        }))
    }
}

struct RelayValidateLease;

impl Operator for RelayValidateLease {
    fn name(&self) -> &'static str {
        "relay.peer_lease.validate"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let lease = obj(values.first().cloned().unwrap_or_default());
        if get_str(&lease, "state") != "issued" {
            return Err("peer lease is not issued".into());
        }
        Ok(json!({
            "leaseId": get_str(&lease, "leaseId"),
            "targetKey": get_str(&lease, "targetKey"),
            "state": "validated",
        }))
    }
}

struct RelayBindTarget;

impl Operator for RelayBindTarget {
    fn name(&self) -> &'static str {
        "relay.peer_lease.bind_target"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let lease = obj(values.first().cloned().unwrap_or_default());
        let route_plan = obj(values.get(1).cloned().unwrap_or_default());
        Ok(json!({
            "targetKey": get_str(&lease, "targetKey"),
            "endpoint": get_str(&route_plan, "selected"),
            "state": "bound",
        }))
    }
}

struct RelayResumeTarget;

impl Operator for RelayResumeTarget {
    fn name(&self) -> &'static str {
        "client.connection_home.resume_target"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let bound = obj(values.first().cloned().unwrap_or_default());
        Ok(json!({
            "action": "resume",
            "targetKey": get_str(&bound, "targetKey"),
            "state": "ready",
        }))
    }
}

struct DaemonAcceptConnection;

impl Operator for DaemonAcceptConnection {
    fn name(&self) -> &'static str {
        "daemon.connection_gateway.accept"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let connection = obj(inputs(input).first().cloned().unwrap_or_default());
        let connection_id = get_str(&connection, "connectionId").to_string();
        if connection_id.is_empty() {
            return Err("physical connection requires connectionId".into());
        }
        let channels = connection
            .get("channels")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        Ok(json!({
            "connectionId": connection_id,
            "channels": channels,
            "state": "accepted",
        }))
    }
}

struct DaemonNegotiateMux;

impl Operator for DaemonNegotiateMux {
    fn name(&self) -> &'static str {
        "daemon.connection_gateway.negotiate_mux"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let accepted = obj(values.first().cloned().unwrap_or_default());
        let caps = obj(values.get(1).cloned().unwrap_or_default());
        if !get_bool(&caps, "muxEnabled") {
            return Err("mux negotiation requires muxEnabled".into());
        }
        let channels = accepted
            .get("channels")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        Ok(json!({
            "muxSessionId": format!("mux-{}", get_str(&accepted, "connectionId")),
            "channels": channels,
            "state": "mux-ready",
        }))
    }
}

struct DaemonRegisterChannel;

impl Operator for DaemonRegisterChannel {
    fn name(&self) -> &'static str {
        "daemon.channel_mux.register"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let mux = obj(inputs(input).first().cloned().unwrap_or_default());
        let channels = mux
            .get("channels")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        Ok(json!({
            "muxSessionId": get_str(&mux, "muxSessionId"),
            "channels": channels,
            "state": "registered",
        }))
    }
}

struct DaemonBindBodySubscription;

impl Operator for DaemonBindBodySubscription {
    fn name(&self) -> &'static str {
        "daemon.transport_subscriber.bind"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let registry = obj(inputs(input).first().cloned().unwrap_or_default());
        let channels = registry
            .get("channels")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let by_channel = subscription_map(&channels);
        Ok(json!({
            "muxSessionId": get_str(&registry, "muxSessionId"),
            "bodySubscribed": !by_channel.is_empty(),
            "bodySubscribedByChannel": Value::Object(by_channel),
            "state": "bound",
        }))
    }
}

struct DaemonUnregisterChannel;

impl Operator for DaemonUnregisterChannel {
    fn name(&self) -> &'static str {
        "daemon.channel_mux.unregister"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let registry = obj(values.first().cloned().unwrap_or_default());
        let removal = obj(values.get(1).cloned().unwrap_or_default());
        let channels = registry
            .get("channels")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let removed_channel = removal
            .get("removedChannelId")
            .cloned()
            .unwrap_or(Value::Null);
        if removed_channel.is_null() || removed_channel.as_str().unwrap_or("").is_empty() {
            return Ok(json!({
                "muxSessionId": get_str(&registry, "muxSessionId"),
                "removedChannelId": Value::Null,
                "channels": channels,
                "state": "noop",
                "reason": "no removedChannelId requested",
            }));
        }
        let removed_channel_id = removed_channel.as_str().unwrap_or("");
        let registered = channels.iter().any(|channel| {
            channel.get("channelId").and_then(Value::as_str) == Some(removed_channel_id)
        });
        if !registered {
            return Err(format!(
                "channel {} is not registered on mux session",
                removed_channel_id
            ));
        }
        let remaining = channels
            .into_iter()
            .filter(|channel| {
                channel.get("channelId").and_then(Value::as_str) != Some(removed_channel_id)
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "muxSessionId": get_str(&registry, "muxSessionId"),
            "removedChannelId": removed_channel,
            "channels": remaining,
            "state": "unregistered",
        }))
    }
}

struct DaemonReleaseBodySubscription;

impl Operator for DaemonReleaseBodySubscription {
    fn name(&self) -> &'static str {
        "daemon.transport_subscriber.release"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let removed = obj(inputs(input).first().cloned().unwrap_or_default());
        match get_str(&removed, "state") {
            "unregistered" => {}
            "noop" => {
                let channels = removed
                    .get("channels")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new()));
                let by_channel = subscription_map(&channels);
                return Ok(json!({
                    "muxSessionId": get_str(&removed, "muxSessionId"),
                    "removedChannelId": Value::Null,
                    "channels": channels,
                    "bodySubscribed": !by_channel.is_empty(),
                    "bodySubscribedByChannel": Value::Object(by_channel),
                    "state": "not-requested",
                }));
            }
            _ => {
                return Err("body subscription release requires an unregistered channel".into());
            }
        }
        let removed_channel = removed
            .get("removedChannelId")
            .cloned()
            .unwrap_or(Value::Null);
        let channels = removed
            .get("channels")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let by_channel = subscription_map(&channels);
        Ok(json!({
            "muxSessionId": get_str(&removed, "muxSessionId"),
            "removedChannelId": removed_channel,
            "channels": channels,
            "bodySubscribed": !by_channel.is_empty(),
            "bodySubscribedByChannel": Value::Object(by_channel),
            "state": "released",
        }))
    }
}

struct DaemonReconcileBodySubscription;

impl Operator for DaemonReconcileBodySubscription {
    fn name(&self) -> &'static str {
        "daemon.transport_subscriber.reconcile_body_subscription"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let subscription = obj(values.first().cloned().unwrap_or_default());
        let update = obj(values.get(1).cloned().unwrap_or_default());
        let mut by_channel = match subscription.get("bodySubscribedByChannel") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        let mut reconciled = false;
        if let Some(Value::Object(updates)) = update.get("bodySubscribedByChannel") {
            for (channel_id, value) in updates {
                if !by_channel.contains_key(channel_id) {
                    return Err(format!(
                        "channel {channel_id} is not registered on mux session"
                    ));
                }
                by_channel.insert(
                    channel_id.clone(),
                    Value::Bool(value.as_bool().unwrap_or(false)),
                );
            }
            reconciled = true;
        }
        let channel_id = get_str(&update, "channelId").to_string();
        if !channel_id.is_empty() {
            if !by_channel.contains_key(&channel_id) {
                return Err(format!(
                    "channel {channel_id} is not registered on mux session"
                ));
            }
            let subscribed = update
                .get("subscribed")
                .or_else(|| update.get("bodySubscribed"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            by_channel.insert(channel_id, Value::Bool(subscribed));
            reconciled = true;
        }
        let body_subscribed = by_channel
            .values()
            .any(|value| value.as_bool() == Some(true));
        Ok(json!({
            "muxSessionId": get_str(&subscription, "muxSessionId"),
            "bodySubscribed": body_subscribed,
            "bodySubscribedByChannel": Value::Object(by_channel),
            "state": if reconciled { "reconciled" } else { "bound" },
        }))
    }
}

struct DaemonSettlePhysicalSubscriber;

impl Operator for DaemonSettlePhysicalSubscriber {
    fn name(&self) -> &'static str {
        "daemon.transport_subscriber.settle_physical_subscriber"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let accepted = obj(values.first().cloned().unwrap_or_default());
        let reconciled = obj(values.get(1).cloned().unwrap_or_default());
        let released = obj(values.get(2).cloned().unwrap_or_default());
        let connection_id = get_str(&accepted, "connectionId").to_string();
        if connection_id.is_empty() {
            return Err("physical subscriber settlement requires connectionId".into());
        }
        let channels = released
            .get("channels")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let active_ids = channels
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|channel| channel.get("channelId").and_then(Value::as_str))
                    .map(|channel_id| channel_id.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let reconciled_by_channel = reconciled
            .get("bodySubscribedByChannel")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut effective_by_channel = Map::new();
        for channel_id in active_ids {
            let value = reconciled_by_channel
                .get(&channel_id)
                .cloned()
                .unwrap_or(Value::Bool(true));
            effective_by_channel.insert(channel_id, value);
        }
        let body_subscribed = effective_by_channel
            .values()
            .any(|value| value.as_bool() == Some(true));
        Ok(json!({
            "connectionId": connection_id,
            "muxSessionId": get_str(&reconciled, "muxSessionId"),
            "channels": channels,
            "bodySubscribed": body_subscribed,
            "bodySubscribedByChannel": Value::Object(effective_by_channel),
            "physicalSubscriberRetained": true,
            "zeroSubscriberRelease": false,
            "state": "settled",
        }))
    }
}

struct DaemonBuildSessionCatalog;

impl Operator for DaemonBuildSessionCatalog {
    fn name(&self) -> &'static str {
        "daemon.session_catalog.build"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let channel = obj(values.first().cloned().unwrap_or_default());
        let subscription = obj(values.get(1).cloned().unwrap_or_default());
        let request = obj(values.get(2).cloned().unwrap_or_default());
        let requested = array_of_strings(request.get("sessionNames"));
        Ok(json!({
            "muxSessionId": get_str(&channel, "muxSessionId"),
            "bodySubscribed": get_bool(&subscription, "bodySubscribed"),
            "sessions": requested,
            "state": "ready",
        }))
    }
}

struct DaemonPublishIdleFacts;

impl Operator for DaemonPublishIdleFacts {
    fn name(&self) -> &'static str {
        "daemon.session_idle_detection.publish"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let catalog = obj(values.first().cloned().unwrap_or_default());
        let sessions = catalog
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(json!({
            "sessions": sessions
                .into_iter()
                .map(|session| json!({
                    "sessionId": session.get("sessionId").cloned().unwrap_or(Value::Null),
                    "idle": false,
                }))
                .collect::<Vec<_>>(),
            "state": "published",
        }))
    }
}

#[cfg(test)]
mod operator_tests {
    use super::*;

    fn context() -> OperatorContext {
        OperatorContext {
            identity: Identity {
                project_id: "zterm".into(),
                graph_id: "test".into(),
                graph_version: "0.1".into(),
                execution_id: "execution".into(),
                attempt_id: "attempt".into(),
            },
            node_id: "node".into(),
        }
    }

    fn run(operator: &dyn Operator, values: Value) -> Result<Value, String> {
        operator.execute(values, &context())
    }

    fn subscription() -> Value {
        json!({
            "muxSessionId": "mux-conn-1",
            "bodySubscribed": true,
            "bodySubscribedByChannel": { "s1": true, "s2": true },
            "state": "bound",
        })
    }

    #[test]
    fn reconcile_without_update_passes_through_binding() {
        let result = run(
            &DaemonReconcileBodySubscription,
            json!([subscription(), {}]),
        )
        .unwrap();
        assert_eq!(result["state"], "bound");
        assert_eq!(result["bodySubscribed"], true);
        assert_eq!(result["bodySubscribedByChannel"]["s1"], true);
    }

    #[test]
    fn reconcile_channel_update_marks_state_and_recomputes_aggregate() {
        let result = run(
            &DaemonReconcileBodySubscription,
            json!([subscription(), { "channelId": "s1", "subscribed": false }]),
        )
        .unwrap();
        assert_eq!(result["state"], "reconciled");
        assert_eq!(result["bodySubscribedByChannel"]["s1"], false);
        // s2 still subscribed so the aggregate stays true.
        assert_eq!(result["bodySubscribed"], true);
    }

    #[test]
    fn reconcile_rejects_unregistered_channel() {
        let error = run(
            &DaemonReconcileBodySubscription,
            json!([subscription(), { "channelId": "unknown", "subscribed": false }]),
        )
        .unwrap_err();
        assert!(error.contains("not registered"));
    }

    #[test]
    fn settle_requires_connection_id() {
        let error = run(
            &DaemonSettlePhysicalSubscriber,
            json!([{}, subscription(), { "channels": [] }]),
        )
        .unwrap_err();
        assert!(error.contains("connectionId"));
    }

    #[test]
    fn settle_filters_released_channels_and_retains_physical_subscriber() {
        let result = run(
            &DaemonSettlePhysicalSubscriber,
            json!([
                { "connectionId": "conn-1", "channels": [], "state": "accepted" },
                {
                    "muxSessionId": "mux-conn-1",
                    "bodySubscribed": true,
                    "bodySubscribedByChannel": { "s1": false, "s2": true },
                    "state": "reconciled",
                },
                { "channels": [{ "channelId": "s2", "sessionName": "s2" }] },
            ]),
        )
        .unwrap();
        assert_eq!(result["state"], "settled");
        assert_eq!(result["connectionId"], "conn-1");
        assert_eq!(result["bodySubscribedByChannel"]["s2"], true);
        assert!(result["bodySubscribedByChannel"].get("s1").is_none());
        assert_eq!(result["bodySubscribed"], true);
        assert_eq!(result["physicalSubscriberRetained"], true);
        assert_eq!(result["zeroSubscriberRelease"], false);
    }

    #[test]
    fn settle_defaults_surviving_channel_absent_from_reconciled_to_subscribed() {
        let result = run(
            &DaemonSettlePhysicalSubscriber,
            json!([
                { "connectionId": "conn-1" },
                { "muxSessionId": "mux-conn-1", "bodySubscribedByChannel": {} },
                { "channels": [{ "channelId": "s9" }] },
            ]),
        )
        .unwrap();
        assert_eq!(result["bodySubscribedByChannel"]["s9"], true);
        assert_eq!(result["bodySubscribed"], true);
        assert_eq!(result["physicalSubscriberRetained"], true);
        assert_eq!(result["zeroSubscriberRelease"], false);
    }
}
