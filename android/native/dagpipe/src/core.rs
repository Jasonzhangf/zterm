//! DAGpipe Phase 1 operators for the zterm Android client core.
//!
//! Every operator here is a pure projection of the approved Phase 0 static
//! graphs in `android/docs/dagpipe/*.graph.json`. Operators receive ARC values
//! only; they never see the graph, scheduler, Runtime, or ARC store.
//!
//! Parity is a contract with the existing TypeScript owners:
//! `android/src/lib/...` and `packages/shared/src/terminal/...`. The black-box
//! tests in `tests/phase0.rs` and
//! `android/src/lib/dagpipe-phase1-parity.test.ts` run the same fixtures
//! through both implementations.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const CONNECTION_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-connection-lifecycle.graph.json");
const BUFFER_MANAGEMENT_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-buffer-management.graph.json");
const BUFFER_RENDER_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-buffer-render.graph.json");
const INPUT_DISPATCH_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-input-dispatch.graph.json");

pub const CONNECTION_GRAPH_ID: &str = "android.connection_lifecycle";
pub const BUFFER_MANAGEMENT_GRAPH_ID: &str = "android.buffer_management";
pub const BUFFER_RENDER_GRAPH_ID: &str = "android.buffer_render";
pub const INPUT_DISPATCH_GRAPH_ID: &str = "android.input_dispatch";
pub const GRAPH_VERSION: &str = "0.1";

pub const TERMINAL_INPUT_CHUNK_BYTES: usize = 64 * 1024;
pub const TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES: u64 = 128 * 1024;
pub const TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT: usize = 8;
pub const BUFFER_FRAME_REPAIR_LEDGER_MAX_REVISIONS: usize = 512;

// ---------------------------------------------------------------------------
// Small JSON helpers shared by every operator.
// ---------------------------------------------------------------------------

fn obj(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn obj_ref(value: &Value) -> Map<String, Value> {
    obj(value.clone())
}

/// Node inputs arrive as a single value for one ARC and as an array for many.
fn inputs(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        other => vec![other],
    }
}

fn as_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn as_i64(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

fn as_bool(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

fn as_str(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn get_u64(object: &Map<String, Value>, key: &str) -> u64 {
    as_u64(object.get(key))
}

fn get_bool(object: &Map<String, Value>, key: &str) -> bool {
    as_bool(object.get(key))
}

fn get_str<'a>(object: &'a Map<String, Value>, key: &str) -> &'a str {
    as_str(object.get(key))
}

/// Mirrors `Math.max(0, Math.floor(value))` for JSON numbers.
fn floor_non_negative(value: Option<&Value>) -> u64 {
    match value.and_then(Value::as_f64) {
        Some(number) if number.is_finite() => number.max(0.0).floor() as u64,
        _ => 0,
    }
}

fn optional_u64(object: &Map<String, Value>, key: &str) -> Option<u64> {
    match object.get(key) {
        Some(Value::Number(number)) => number.as_f64().map(|value| {
            if value.is_finite() {
                value.max(0.0).floor() as u64
            } else {
                0
            }
        }),
        _ => None,
    }
}

fn range(start_index: u64, end_index: u64) -> Value {
    json!({ "startIndex": start_index, "endIndex": end_index })
}

fn read_range(value: &Value) -> (u64, u64) {
    (
        as_u64(value.get("startIndex")),
        as_u64(value.get("endIndex")),
    )
}

/// Mirrors `mergeGapRanges` in `packages/shared/src/terminal/gap-utils.ts`.
fn merge_gap_ranges(ranges: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut sorted: Vec<(u64, u64)> = ranges
        .iter()
        .copied()
        .filter(|(start, end)| end > start)
        .collect();
    sorted.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::new();
    for (start, end) in sorted {
        match merged.last_mut() {
            Some(last) if start <= last.1 => {
                last.1 = last.1.max(end);
            }
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Mirrors `collectIntersectingGapRanges` in `gap-utils.ts`.
fn collect_intersecting(ranges: &[(u64, u64)], start: u64, end: u64) -> Vec<(u64, u64)> {
    if end <= start {
        return Vec::new();
    }
    ranges
        .iter()
        .map(|(range_start, range_end)| (start.max(*range_start), end.min(*range_end)))
        .filter(|(range_start, range_end)| range_end > range_start)
        .collect()
}

/// Mirrors `resolveRequestedBufferWindow` in `gap-utils.ts`.
fn resolve_requested_buffer_window(
    end_index: u64,
    viewport_rows: u64,
    cache_lines: u64,
    min_start_index: u64,
) -> (u64, u64) {
    let safe_viewport = viewport_rows.max(1);
    let safe_end = end_index;
    let safe_min = min_start_index;
    let safe_cache = cache_lines.max(safe_viewport);
    let request_end_index = safe_min.max(safe_end);
    let request_start_index = safe_min.max(request_end_index.saturating_sub(safe_cache));
    (request_start_index, request_end_index)
}

fn ranges_from_value(value: Option<&Value>) -> Vec<(u64, u64)> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(read_range).collect())
        .unwrap_or_default()
}

fn ranges_to_value(ranges: &[(u64, u64)]) -> Value {
    Value::Array(
        ranges
            .iter()
            .map(|(start, end)| range(*start, *end))
            .collect(),
    )
}

fn frame_indexes_cover(lines: &[Value], start: u64, end: u64) -> Option<u64> {
    let mut indexes = BTreeSet::new();
    for line in lines {
        indexes.insert(get_u64(&obj_ref(line), "index"));
    }
    (start..end).find(|index| !indexes.contains(index))
}

// ---------------------------------------------------------------------------
// Graph compilation entrypoint.
// ---------------------------------------------------------------------------

fn parse(graph_json: &str) -> Result<Graph, CompileError> {
    parse_graph_json(graph_json)
}

fn register_all(registry: &mut Registry) {
    macro_rules! register {
        ($op:expr) => {
            registry.register($op).expect("register operator")
        };
    }
    // android.connection_lifecycle
    register!(RelayAccountLogin);
    register!(RelayAccountPublishDevice);
    register!(ConnectionResolveRoutes);
    register!(ConnectionEstablishTransport);
    register!(ConnectionNegotiateMux);
    register!(SessionChannelOpenAll);
    register!(SessionChannelSubscribeBodies);
    register!(ConnectionMaintain);
    register!(ConnectionPlanRecovery);
    // android.buffer_management
    register!(BufferManagerObserveHeads);
    register!(BufferManagerPlanWindows);
    register!(BufferManagerDispatchRequests);
    register!(BufferManagerIngestResponses);
    register!(BufferManagerMergeSparse);
    register!(BufferManagerUpdateRepairLedger);
    register!(BufferManagerPublishRenderScope);
    // android.buffer_render
    register!(WireIngressNormalize);
    register!(BufferFrameAssemblyAssemble);
    register!(BufferPlannerPlan);
    register!(SparseBufferApply);
    register!(BufferPlannerRequest);
    register!(RendererWindowCommit);
    register!(DomRendererProject);
    // android.input_dispatch
    register!(InputNormalizerNormalize);
    register!(ReliableInputPlan);
    register!(ReliableInputEmit);
    crate::sese_core::register_sese_operators(registry);
}

pub fn compile_phase0_graphs() -> Result<Vec<String>, CompileError> {
    let mut registry = Registry::default();
    register_all(&mut registry);
    let capabilities = BTreeSet::new();
    for source in [
        CONNECTION_GRAPH_JSON,
        BUFFER_MANAGEMENT_GRAPH_JSON,
        BUFFER_RENDER_GRAPH_JSON,
        INPUT_DISPATCH_GRAPH_JSON,
    ] {
        compile(parse(source)?, &registry, &capabilities)?;
    }
    Ok(vec![
        format!("{CONNECTION_GRAPH_ID}@{GRAPH_VERSION}"),
        format!("{BUFFER_MANAGEMENT_GRAPH_ID}@{GRAPH_VERSION}"),
        format!("{BUFFER_RENDER_GRAPH_ID}@{GRAPH_VERSION}"),
        format!("{INPUT_DISPATCH_GRAPH_ID}@{GRAPH_VERSION}"),
    ])
}

fn run_graph(
    request: Value,
    graph_json: &str,
    graph_id: &str,
    output_arc: &str,
) -> serde_json::Result<Value> {
    let request = obj(request);
    let execution_id = get_str(&request, "execution_id").to_string();
    let attempt_id = get_str(&request, "attempt_id").to_string();
    let mut inputs = request
        .get("inputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<HashMap<String, Value>>();
    if let Ok(graph_value) = serde_json::from_str::<Value>(graph_json) {
        crate::sese_core::wrap_request_inputs(&graph_value, &mut inputs);
    }
    let mut registry = Registry::default();
    register_all(&mut registry);
    let capabilities = BTreeSet::new();
    let compiled =
        match parse(graph_json).and_then(|graph| compile(graph, &registry, &capabilities)) {
            Ok(compiled) => compiled,
            Err(error) => {
                return Ok(json!({ "ok": false, "error": error.message }));
            }
        };
    let identity = Identity {
        project_id: "zterm".into(),
        graph_id: graph_id.into(),
        graph_version: GRAPH_VERSION.into(),
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
    match runtime.run(&compiled, identity, inputs, &Cancellation::default()) {
        Ok(result) => {
            let mut outputs = serde_json::Map::new();
            for (arc_id, arc) in crate::sese_core::unwrap_result_outputs(&result.outputs) {
                outputs.insert(arc_id, arc.payload.clone());
            }
            let _ = output_arc;
            Ok(json!({ "ok": true, "outputs": Value::Object(outputs) }))
        }
        Err(failure) => Ok(json!({
            "ok": false,
            "error": failure.error.message,
        })),
    }
}

pub fn run_connection_lifecycle_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        CONNECTION_GRAPH_JSON,
        CONNECTION_GRAPH_ID,
        "arc.recovery_plan",
    )
}

pub fn run_buffer_management_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        BUFFER_MANAGEMENT_GRAPH_JSON,
        BUFFER_MANAGEMENT_GRAPH_ID,
        "arc.render_scope",
    )
}

pub fn run_buffer_render_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        BUFFER_RENDER_GRAPH_JSON,
        BUFFER_RENDER_GRAPH_ID,
        "arc.dom_commit",
    )
}

pub fn run_input_dispatch_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        INPUT_DISPATCH_GRAPH_JSON,
        INPUT_DISPATCH_GRAPH_ID,
        "arc.mux_channel_send",
    )
}

// ---------------------------------------------------------------------------
// Operators: android.connection_lifecycle
// ---------------------------------------------------------------------------

struct RelayAccountLogin;

impl Operator for RelayAccountLogin {
    fn name(&self) -> &'static str {
        "client.relay_account.login"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let credentials = obj(values.first().cloned().unwrap_or_default());
        let settings = obj(values.get(1).cloned().unwrap_or_default());
        let account_id = get_str(&credentials, "accountId").to_string();
        let auth_token = get_str(&credentials, "authToken").to_string();
        if account_id.is_empty() && auth_token.is_empty() {
            return Err("relay login requires account credentials".into());
        }
        Ok(json!({
            "state": "logged-in",
            "accountId": if account_id.is_empty() { "anon".to_string() } else { account_id },
            "authToken": auth_token,
            "tokenPerLogin": true,
            "relayEnabled": get_bool(&settings, "relayEnabled"),
            "savedDirectTargetsPreserved": true,
            "role": "client.relay_account",
        }))
    }
}

struct RelayAccountPublishDevice;

impl Operator for RelayAccountPublishDevice {
    fn name(&self) -> &'static str {
        "client.relay_account.publish_device"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let session = obj(input);
        if get_str(&session, "state") != "logged-in" {
            return Err("cannot publish device before relay login".into());
        }
        let device_id = get_str(&session, "deviceId")
            .to_string()
            .pipe_default("zterm-android-client");
        Ok(json!({
            "deviceId": device_id,
            "connected": true,
            "platform": "android",
            "accountId": get_str(&session, "accountId"),
            "published": true,
            "role": "client.relay_account.publish_device",
        }))
    }
}

trait PipeDefault {
    fn pipe_default(self, default: &str) -> String;
}

impl PipeDefault for String {
    fn pipe_default(self, default: &str) -> String {
        if self.is_empty() {
            default.to_string()
        } else {
            self
        }
    }
}

struct ConnectionResolveRoutes;

impl Operator for ConnectionResolveRoutes {
    fn name(&self) -> &'static str {
        "client.connection.resolve_routes"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let candidates = values
            .first()
            .and_then(|value| value.get("candidates"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let policy = values.get(3).cloned().unwrap_or_else(|| json!({}));
        let priority = policy
            .get("pathPriority")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                json!(["LAN", "UDP direct", "Tailscale", "Relay"])
                    .as_array()
                    .cloned()
                    .unwrap()
            })
            .into_iter()
            .filter_map(|value| value.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        let default_priority = ["LAN", "UDP direct", "Tailscale", "Relay"];
        let mut routes = Vec::new();
        for candidate in candidates {
            let path = get_str(&obj(candidate.clone()), "path").to_string();
            let endpoint = get_str(&obj(candidate.clone()), "endpoint").to_string();
            let id = get_str(&obj(candidate.clone()), "id").to_string();
            let candidate_obj = obj(candidate.clone());
            let health = candidate_obj.get("health").cloned().unwrap_or_default();
            let health_obj = obj_ref(&health);
            let health_status = get_str(&health_obj, "status").to_string();
            let selectable = health_status.is_empty() || health_status == "success";
            let priority_index = if priority.is_empty() {
                default_priority
                    .iter()
                    .position(|p| p == &path)
                    .unwrap_or(default_priority.len())
            } else {
                priority
                    .iter()
                    .position(|p| p == &path)
                    .unwrap_or(priority.len())
            };
            let health_score = if health_status == "auth-failure" {
                900
            } else if health_status == "failure" {
                500
            } else if health_status == "success" {
                -1000 + (get_u64(&health_obj, "rttMs").min(100) as i64 / 10)
            } else {
                20
            };
            let score = (priority_index * 100) as i64 + health_score;
            routes.push(json!({
                "candidateId": id,
                "path": path,
                "endpoint": endpoint,
                "selectable": selectable,
                "score": score,
                "priority": priority_index as u64,
                "healthScore": health_score,
            }));
        }
        let diagnostics = routes.clone();
        routes.retain(|route| get_bool(&obj_ref(route), "selectable"));
        routes.sort_by(|left, right| {
            let left_priority = as_i64(left.get("priority"));
            let right_priority = as_i64(right.get("priority"));
            let tier_cmp = left_priority.cmp(&right_priority);
            if tier_cmp != std::cmp::Ordering::Equal {
                return tier_cmp;
            }
            let left_health = as_i64(left.get("healthScore"));
            let right_health = as_i64(right.get("healthScore"));
            left_health.cmp(&right_health)
        });
        let selected = routes.first().cloned();
        Ok(json!({
            "selected": selected,
            "diagnostics": diagnostics,
            "role": "client.connection.resolve_routes",
        }))
    }
}

struct ConnectionEstablishTransport;

impl Operator for ConnectionEstablishTransport {
    fn name(&self) -> &'static str {
        "client.connection.establish_transport"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let route = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let selected = route.get("selected").cloned().unwrap_or_default();
        let selected_obj = obj(selected);
        let endpoint = get_str(&selected_obj, "endpoint").to_string();
        if endpoint.is_empty() {
            return Err("cannot establish transport without a resolved route".into());
        }
        let target_key = get_str(&selected_obj, "candidateId")
            .to_string()
            .pipe_default(&endpoint);
        let expected_generation = get_u64(&policy, "expectedGeneration");
        Ok(json!({
            "targetKey": target_key,
            "transportId": format!("t-{target_key}"),
            "state": if expected_generation == 0 { "connecting" } else { "established" },
            "generation": if expected_generation > 0 { expected_generation } else { 1 },
            "sessions": [],
            "role": "client.connection.establish_transport",
        }))
    }
}

struct ConnectionNegotiateMux;

impl Operator for ConnectionNegotiateMux {
    fn name(&self) -> &'static str {
        "client.connection.negotiate_mux"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let transport = obj(input);
        let target_key = get_str(&transport, "targetKey").to_string();
        if target_key.is_empty() {
            return Err("mux negotiation requires a physical transport".into());
        }
        if get_str(&transport, "state") != "established" {
            return Err("cannot negotiate mux before transport is established".into());
        }
        Ok(json!({
            "targetKey": target_key,
            "state": "ready",
            "transportGeneration": get_u64(&transport, "generation"),
            "role": "client.connection.negotiate_mux",
        }))
    }
}

struct SessionChannelOpenAll;

impl Operator for SessionChannelOpenAll {
    fn name(&self) -> &'static str {
        "client.session_channel.open_all"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let mux = obj(values.first().cloned().unwrap_or_default());
        let target_key = get_str(&mux, "targetKey").to_string();
        let demand = obj(values.get(1).cloned().unwrap_or_default());
        let sessions = demand
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let channels = sessions
            .iter()
            .enumerate()
            .map(|(index, session)| {
                let session_obj = obj(session.clone());
                let session_id = get_str(&session_obj, "sessionId").to_string();
                let session_name = get_str(&session_obj, "sessionName").to_string();
                json!({
                    "channelId": if session_id.is_empty() {
                        format!("ch-{target_key}-{index}")
                    } else {
                        format!("ch-{target_key}-{session_id}")
                    },
                    "sessionId": session_id,
                    "sessionName": session_name,
                    "targetKey": target_key,
                    "state": "open",
                    "bodySubscribed": false,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "channels": channels,
            "targetKey": target_key,
            "role": "client.session_channel.open_all",
        }))
    }
}

struct SessionChannelSubscribeBodies;

impl Operator for SessionChannelSubscribeBodies {
    fn name(&self) -> &'static str {
        "client.session_channel.subscribe_bodies"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let channels_store = obj(values.first().cloned().unwrap_or_default());
        let demand = obj(values.get(1).cloned().unwrap_or_default());
        let channels = channels_store
            .get("channels")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut subscriptions = Vec::new();
        for channel in channels {
            let channel_obj = obj(channel);
            let session_id = get_str(&channel_obj, "sessionId").to_string();
            let session_demand = demand
                .get("sessions")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| get_str(&obj_ref(item), "sessionId") == session_id)
                        .cloned()
                })
                .unwrap_or_else(|| json!({ "mode": "inactive" }));
            let mode = get_str(&obj(session_demand), "mode").to_string();
            let body_subscribed = channel_obj
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("open")
                == "open"
                && mode != "inactive";
            subscriptions.push(json!({
                "sessionId": session_id,
                "channelId": get_str(&channel_obj, "channelId"),
                "bodySubscribed": body_subscribed,
                "mode": if mode.is_empty() { "active".to_string() } else { mode },
            }));
        }
        Ok(
            json!({ "subscriptions": subscriptions, "role": "client.session_channel.subscribe_bodies" }),
        )
    }
}

struct ConnectionMaintain;

impl Operator for ConnectionMaintain {
    fn name(&self) -> &'static str {
        "client.connection.maintain"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let transport = obj(values.first().cloned().unwrap_or_default());
        let mux = obj(values.get(1).cloned().unwrap_or_default());
        let subscriptions_value = values.get(2).cloned().unwrap_or_default();
        let subscription_count = subscriptions_value
            .get("subscriptions")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0);
        Ok(json!({
            "state": "healthy",
            "targetKey": get_str(&transport, "targetKey"),
            "generation": get_u64(&transport, "generation"),
            "muxState": get_str(&mux, "state"),
            "activeSessionChannelCount": subscription_count as u64,
            "role": "client.connection.maintain",
        }))
    }
}

struct ConnectionPlanRecovery;

impl Operator for ConnectionPlanRecovery {
    fn name(&self) -> &'static str {
        "client.connection.plan_recovery"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let health = obj(values.first().cloned().unwrap_or_default());
        let state = get_str(&health, "state");
        let healthy = state == "healthy";
        Ok(json!({
            "recoveryNeeded": !healthy,
            "newAttempt": !healthy,
            "nextGeneration": if healthy { get_u64(&health, "generation") } else { get_u64(&health, "generation") + 1 },
            "preserveSessions": true,
            "role": "client.connection.plan_recovery",
        }))
    }
}

// ---------------------------------------------------------------------------
// Operators: android.buffer_management
// ---------------------------------------------------------------------------

struct BufferManagerObserveHeads;

impl Operator for BufferManagerObserveHeads {
    fn name(&self) -> &'static str {
        "client.buffer_manager.observe_heads"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let demand = obj(values.get(1).unwrap_or(&json!({})).clone());
        let heads = obj(values.first().unwrap_or(&json!({})).clone());
        let sessions = demand
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let observations = sessions
            .into_iter()
            .map(|session| {
                let session_id = get_str(&obj(session.clone()), "sessionId").to_string();
                let head = heads
                    .get("sessions")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items
                            .iter()
                            .find(|item| get_str(&obj_ref(item), "sessionId") == session_id)
                    })
                    .cloned()
                    .unwrap_or_else(|| json!({"revision":0,"latestEndIndex":0}));
                json!({
                    "sessionId": session_id,
                    "revision": get_u64(&obj_ref(&head), "revision"),
                    "latestEndIndex": get_u64(&obj_ref(&head), "latestEndIndex"),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "observations": observations, "role": "client.buffer_manager.observe_heads" }))
    }
}

struct BufferManagerPlanWindows;

impl Operator for BufferManagerPlanWindows {
    fn name(&self) -> &'static str {
        "client.buffer_manager.plan_windows"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let heads = obj(values.first().unwrap_or(&json!({})).clone());
        let local = obj(values.get(1).unwrap_or(&json!({})).clone());
        let demand = obj(values.get(2).unwrap_or(&json!({})).clone());
        let policy = obj(values.get(3).unwrap_or(&json!({})).clone());
        let cache_lines = get_u64(&policy, "cacheLines").max(1);
        let sessions = demand
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let observations = heads
            .get("observations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut window_sessions = Vec::new();
        for session in sessions {
            let session_id = get_str(&obj(session.clone()), "sessionId").to_string();
            let mode = get_str(&obj(session.clone()), "mode").to_string();
            let observation = observations
                .iter()
                .find(|ob| get_str(&obj_ref(ob), "sessionId") == session_id)
                .cloned()
                .unwrap_or_else(|| json!({"revision":0,"latestEndIndex":0}));
            let head_revision = get_u64(&obj_ref(&observation), "revision");
            let head_end_index = get_u64(&obj_ref(&observation), "latestEndIndex");
            let local_session = local
                .get("sessions")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| get_str(&obj_ref(item), "sessionId") == session_id)
                })
                .cloned()
                .unwrap_or_else(
                    || json!({"revision":0,"startIndex":0,"endIndex":0,"gapRanges":[]}),
                );
            let local_start = get_u64(&obj_ref(&local_session), "startIndex");
            let local_end = get_u64(&obj_ref(&local_session), "endIndex");
            let local_revision = get_u64(&obj_ref(&local_session), "revision");
            let local_has_window = local_end > local_start && local_revision > 0;
            let mode = if mode.is_empty() {
                "active".to_string()
            } else {
                mode
            };
            let (start_index, end_index, should_pull) = if mode == "inactive" {
                (local_start, local_end, false)
            } else {
                let distance_to_head = head_end_index.saturating_sub(local_end);
                let same_end_advanced =
                    local_has_window && distance_to_head == 0 && head_revision > local_revision;
                let request = resolve_requested_buffer_window(
                    head_end_index,
                    get_u64(&obj(session), "viewportRows").max(24),
                    cache_lines,
                    0,
                );
                let pull = !local_has_window
                    || distance_to_head > cache_lines
                    || local_end < head_end_index
                    || same_end_advanced;
                (request.0, request.1.max(local_end), pull)
            };
            window_sessions.push(json!({
                "sessionId": session_id,
                "mode": mode,
                "startIndex": start_index,
                "endIndex": end_index,
                "shouldPull": should_pull,
            }));
        }
        Ok(json!({ "sessions": window_sessions, "role": "client.buffer_manager.plan_windows" }))
    }
}

struct BufferManagerDispatchRequests;

impl Operator for BufferManagerDispatchRequests {
    fn name(&self) -> &'static str {
        "client.buffer_manager.dispatch_requests"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let windows = obj(values.first().unwrap_or(&json!({})).clone());
        let policy = obj(values.get(1).unwrap_or(&json!({})).clone());
        let mut requests = Vec::new();
        for session in windows
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let should_pull = get_bool(&obj_ref(&session), "shouldPull");
            if !should_pull {
                continue;
            }
            requests.push(json!({
                "sessionId": get_str(&obj_ref(&session), "sessionId"),
                "startIndex": get_u64(&obj_ref(&session), "startIndex"),
                "endIndex": get_u64(&obj_ref(&session), "endIndex"),
                "purpose": get_str(&obj_ref(&session), "mode"),
            }));
        }
        Ok(json!({
            "requests": requests,
            "dispatchBudget": get_u64(&policy, "dispatchBudget").max(1),
            "role": "client.buffer_manager.dispatch_requests",
        }))
    }
}

struct BufferManagerIngestResponses;

impl Operator for BufferManagerIngestResponses {
    fn name(&self) -> &'static str {
        "client.buffer_manager.ingest_responses"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let requests = obj(values.first().unwrap_or(&json!({})).clone());
        let wire = obj(values.get(1).unwrap_or(&json!({})).clone());
        let wire_responses = wire
            .get("responses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let responses = requests
            .get("requests")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|request| {
                let session_id = get_str(&obj_ref(&request), "sessionId").to_string();
                let start_index = get_u64(&obj_ref(&request), "startIndex");
                let end_index = get_u64(&obj_ref(&request), "endIndex");
                let wire_hit = wire_responses.iter().find(|response| {
                    let response_obj = obj_ref(response);
                    let response_start = get_u64(&response_obj, "startIndex");
                    let response_end = get_u64(&response_obj, "endIndex");
                    get_str(&response_obj, "sessionId") == session_id
                        && response_start <= start_index
                        && response_end >= end_index
                });
                json!({
                    "sessionId": session_id,
                    "startIndex": start_index,
                    "endIndex": end_index,
                    "received": wire_hit.is_some(),
                    "revision": wire_hit
                        .and_then(|response| obj_ref(response).get("revision").cloned())
                        .unwrap_or(Value::Null),
                    "reason": if wire_hit.is_some() {
                        "wire-response-covers-request"
                    } else {
                        "awaiting-wire-response"
                    },
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "responses": responses, "role": "client.buffer_manager.ingest_responses" }))
    }
}

struct BufferManagerMergeSparse;

impl Operator for BufferManagerMergeSparse {
    fn name(&self) -> &'static str {
        "client.buffer_manager.merge_sparse"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let responses = obj(values.first().unwrap_or(&json!({})).clone());
        let existing = obj(values.get(1).unwrap_or(&json!({})).clone());
        let existing_sessions = existing
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let responses = responses
            .get("responses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut by_session: HashMap<String, Value> = existing_sessions
            .into_iter()
            .map(|item| {
                let id = get_str(&obj(item.clone()), "sessionId").to_string();
                (id, item)
            })
            .collect();
        for response in responses {
            let session_id = get_str(&obj_ref(&response), "sessionId").to_string();
            let previous = by_session.get(&session_id).cloned().unwrap_or_else(
                || json!({"revision":0,"startIndex":0,"endIndex":0,"gapRanges":[]}),
            );
            let previous_obj = obj(previous);
            if !get_bool(&obj_ref(&response), "received") {
                continue;
            }
            let Some(response_revision) = optional_u64(&obj_ref(&response), "revision") else {
                continue;
            };
            let previous_revision = get_u64(&previous_obj, "revision");
            if response_revision < previous_revision {
                continue;
            }
            let start = get_u64(&obj_ref(&response), "startIndex");
            let end = get_u64(&obj_ref(&response), "endIndex").max(start);
            let previous_empty = get_u64(&previous_obj, "revision") == 0
                && get_u64(&previous_obj, "startIndex") == 0
                && get_u64(&previous_obj, "endIndex") == 0;
            let next_start = if previous_empty {
                start
            } else {
                start.min(get_u64(&previous_obj, "startIndex"))
            };
            let previous_gaps = ranges_from_value(previous_obj.get("gapRanges"));
            let mut covered_gaps = Vec::new();
            for gap in previous_gaps {
                let (gap_start, gap_end) = gap;
                if gap_end <= start || gap_start >= end {
                    covered_gaps.push(gap);
                    continue;
                }
                if gap_start < start {
                    covered_gaps.push((gap_start, start));
                }
                if gap_end > end {
                    covered_gaps.push((end, gap_end));
                }
            }
            let merged = json!({
                "sessionId": session_id,
                "revision": response_revision,
                "startIndex": next_start,
                "endIndex": end.max(get_u64(&previous_obj, "endIndex")),
                "gapRanges": ranges_to_value(&merge_gap_ranges(&covered_gaps)),
            });
            by_session.insert(session_id, merged);
        }
        let mut sessions = by_session.into_values().collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            get_str(&obj_ref(a), "sessionId").cmp(get_str(&obj_ref(b), "sessionId"))
        });
        Ok(json!({ "sessions": sessions, "role": "client.buffer_manager.merge_sparse" }))
    }
}

struct BufferManagerUpdateRepairLedger;

impl Operator for BufferManagerUpdateRepairLedger {
    fn name(&self) -> &'static str {
        "client.buffer_manager.update_repair_ledger"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let sparse = obj(values.get(1).unwrap_or(&json!({})).clone());
        let sessions = sparse
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut sessions_by_id = HashMap::<String, Value>::new();
        for session in sessions {
            let session_id = get_str(&obj_ref(&session), "sessionId").to_string();
            sessions_by_id.insert(session_id, session);
        }
        let mut ledger = Vec::new();
        for (session_id, sparse_session) in sessions_by_id {
            let sparse_obj = obj(sparse_session);
            let mut repair = ranges_from_value(sparse_obj.get("gapRanges"));
            repair = merge_gap_ranges(&repair);
            ledger.push(json!({
                "sessionId": session_id,
                "pendingRanges": ranges_to_value(&repair),
                "status": if repair.is_empty() { "none" } else { "pending" },
            }));
        }
        ledger.sort_by(|left, right| {
            get_str(&obj_ref(left), "sessionId").cmp(get_str(&obj_ref(right), "sessionId"))
        });
        Ok(json!({ "ledger": ledger, "role": "client.buffer_manager.update_repair_ledger" }))
    }
}

struct BufferManagerPublishRenderScope;

impl Operator for BufferManagerPublishRenderScope {
    fn name(&self) -> &'static str {
        "client.buffer_manager.publish_render_scope"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let sparse = obj(values.first().unwrap_or(&json!({})).clone());
        let demand = obj(values.get(1).unwrap_or(&json!({})).clone());
        let demand_sessions = demand
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let scenes = sparse
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|session| {
                let session_id = get_str(&obj_ref(&session), "sessionId").to_string();
                let mode = demand_sessions
                    .iter()
                    .find(|item| get_str(&obj_ref(item), "sessionId") == session_id)
                    .map(|item| get_str(&obj_ref(item), "mode").to_string())
                    .unwrap_or_else(|| "inactive".to_string());
                json!({
                    "sessionId": session_id,
                    "visible": mode != "inactive",
                    "scope": if mode == "inactive" { Value::Null } else {
                        json!({
                            "startIndex": get_u64(&obj_ref(&session), "startIndex"),
                            "endIndex": get_u64(&obj_ref(&session), "endIndex"),
                        })
                    },
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "scopes": scenes, "role": "client.buffer_manager.publish_render_scope" }))
    }
}

// ---------------------------------------------------------------------------
// Operators: android.buffer_render
// ---------------------------------------------------------------------------

fn normalize_incoming_payload(value: Value) -> Value {
    let mut payload = obj(value);
    let start_index = floor_non_negative(payload.get("startIndex"));
    let raw_end = floor_non_negative(payload.get("endIndex"));
    let end_index = start_index.max(raw_end);
    let rows = match payload.get("rows").and_then(Value::as_f64) {
        Some(number) if number.is_finite() => (number.max(1.0).floor()) as u64,
        _ => 24,
    };
    let cols = match payload.get("cols").and_then(Value::as_f64) {
        Some(number) if number.is_finite() => (number.max(1.0).floor()) as u64,
        _ => 80,
    };
    let revision = payload
        .get("revision")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0) as i64;
    let available_end = payload
        .get("availableEndIndex")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|number| start_index.max((number.max(0.0).floor()) as u64));
    let lines = payload
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let normalized_lines = normalize_lines(lines, cols);
    payload.insert("revision".into(), json!(revision.max(0)));
    payload.insert("startIndex".into(), json!(start_index));
    payload.insert("endIndex".into(), json!(end_index));
    payload.insert("rows".into(), json!(rows));
    payload.insert("cols".into(), json!(cols));
    if let Some(end) = available_end {
        payload.insert("availableEndIndex".into(), json!(end));
    }
    payload.insert("lines".into(), Value::Array(normalized_lines));
    payload.entry("cursor".to_string()).or_insert(Value::Null);
    payload
        .entry("cursorKeysApp".to_string())
        .or_insert(Value::Bool(false));
    Value::Object(payload)
}

fn normalize_lines(lines: Vec<Value>, cols: u64) -> Vec<Value> {
    let mut result = Vec::new();
    let mut indexed = false;
    for line in lines {
        let line_obj = obj(line);
        if let Some(index) =
            optional_u64(&line_obj, "index").or_else(|| optional_u64(&line_obj, "i"))
        {
            let cells = line_obj.get("cells").cloned().unwrap_or_else(|| json!([]));
            result.push(json!({ "index": index, "cells": normalize_cells(&cells) }));
            indexed = true;
        } else if let Some(text) = line_obj.get("t").and_then(Value::as_str) {
            let index = optional_u64(&line_obj, "i").unwrap_or(0);
            result.push(json!({
                "index": index,
                "cells": text.chars().map(|ch| json!({"char": ch as u64, "fg": 256, "bg": 256, "flags": 0, "width": 1})).collect::<Vec<_>>(),
            }));
            indexed = true;
        }
    }
    if indexed {
        result.sort_by(|left, right| {
            get_json_u64(obj_ref(left).get("index")).cmp(&get_json_u64(obj_ref(right).get("index")))
        });
    }
    let _ = cols;
    result
}

fn get_json_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn normalize_cells(cells: &Value) -> Vec<Value> {
    cells
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|cell| cell.is_object())
                .map(|cell| {
                    let map = obj(cell.clone());
                    json!({
                        "char": get_u64(&map, "char"),
                        "fg": optional_u64(&map, "fg").unwrap_or(256),
                        "bg": optional_u64(&map, "bg").unwrap_or(256),
                        "flags": get_u64(&map, "flags"),
                        "width": optional_u64(&map, "width").unwrap_or(1),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

trait PipeOr {
    fn pipe_or(self, default: u64) -> u64;
}

impl PipeOr for u64 {
    fn pipe_or(self, default: u64) -> u64 {
        if self == 0 {
            default
        } else {
            self
        }
    }
}

struct WireIngressNormalize;

impl Operator for WireIngressNormalize {
    fn name(&self) -> &'static str {
        "client.wire_ingress.normalize"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        Ok(normalize_incoming_payload(input))
    }
}

struct BufferFrameAssemblyAssemble;

impl Operator for BufferFrameAssemblyAssemble {
    fn name(&self) -> &'static str {
        "client.buffer_frame_assembly.assemble"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let payload = normalize_incoming_payload(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let payload_obj = obj(payload);
        let chunk_count = optional_u64(&payload_obj, "frameChunkCount");
        let start = get_u64(&payload_obj, "startIndex");
        let end = get_u64(&payload_obj, "endIndex");
        let frame_start = optional_u64(&payload_obj, "frameStartIndex").unwrap_or(start);
        let frame_end = optional_u64(&payload_obj, "frameEndIndex").unwrap_or(end);
        if end == start {
            return Ok(Value::Object(payload_obj));
        }
        if end < start {
            return Err("buffer frame has an invalid row range".into());
        }
        match chunk_count {
            Some(count) if count > 1 => {
                let mut chunks = policy
                    .get("frameAssembly")
                    .and_then(|assembly| assembly.get("chunks"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let incoming_start = get_u64(&payload_obj, "startIndex");
                let incoming_end = get_u64(&payload_obj, "endIndex");
                if incoming_start < frame_end && incoming_end > frame_start {
                    let incoming_index = chunks.iter().position(|chunk| {
                        get_u64(&obj_ref(chunk), "startIndex") == incoming_start
                            && get_u64(&obj_ref(chunk), "endIndex") == incoming_end
                    });
                    if let Some(index) = incoming_index {
                        chunks[index] = Value::Object(payload_obj.clone());
                    } else {
                        chunks.push(Value::Object(payload_obj.clone()));
                    }
                }
                chunks.sort_by(|left, right| {
                    get_u64(&obj_ref(left), "startIndex")
                        .cmp(&get_u64(&obj_ref(right), "startIndex"))
                });
                let mut lines = Vec::new();
                let mut expected = frame_start;
                for chunk in chunks.iter() {
                    let chunk_obj = obj(chunk.clone());
                    let chunk_start = get_u64(&chunk_obj, "startIndex");
                    let chunk_end = get_u64(&chunk_obj, "endIndex");
                    if chunk_start != expected {
                        return Ok(json!({
                            "kind": "rejected",
                            "error": "non-contiguous-frame",
                            "state": null,
                            "repairRange": range(frame_start, frame_end),
                            "repairRevision": null,
                        }));
                    }
                    lines.extend(
                        chunk_obj
                            .get("lines")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    );
                    expected = chunk_end;
                }
                if expected != frame_end {
                    return Ok(json!({
                        "kind": "pending",
                        "state": {
                            "frameStartIndex": frame_start,
                            "frameEndIndex": frame_end,
                            "receivedChunks": chunks.len(),
                            "frameChunkCount": count,
                        },
                    }));
                }
                if let Some(missing) = frame_indexes_cover(&lines, frame_start, frame_end) {
                    return Ok(json!({
                        "kind": "rejected",
                        "error": "frame-has-hole",
                        "state": null,
                        "repairRange": range(missing, frame_end),
                        "repairRevision": null,
                    }));
                }
                let mut complete = payload_obj.clone();
                complete.insert("startIndex".into(), json!(frame_start));
                complete.insert("endIndex".into(), json!(frame_end));
                complete.insert("frameChunkIndex".into(), json!(0));
                complete.insert("frameChunkCount".into(), json!(1));
                complete.insert("lines".into(), Value::Array(lines));
                Ok(Value::Object(complete))
            }
            _ => {
                let lines = payload_obj
                    .get("lines")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Some(missing) = frame_indexes_cover(&lines, start, end) {
                    return Ok(json!({
                        "kind": "rejected",
                        "error": "frame-has-hole",
                        "state": null,
                        "repairRange": range(missing, end),
                        "repairRevision": null,
                    }));
                }
                Ok(Value::Object(payload_obj))
            }
        }
    }
}

struct BufferPlannerPlan;

impl Operator for BufferPlannerPlan {
    fn name(&self) -> &'static str {
        "client.buffer_planner.plan"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let complete = values.first().cloned().unwrap_or_default();
        let local = values.get(1).cloned().unwrap_or_default();
        let visible = values.get(2).cloned().unwrap_or_default();
        let policy = values.get(3).cloned().unwrap_or_default();
        let frame = complete;
        let frame_obj = obj(frame);
        let frame_start = get_u64(&frame_obj, "startIndex");
        let frame_end = get_u64(&frame_obj, "endIndex");
        let local_obj = obj(local);
        let local_start = get_u64(&local_obj, "startIndex");
        let local_end = get_u64(&local_obj, "endIndex");
        let visible_obj = obj(visible);
        let visible_start = get_u64(&visible_obj, "startIndex");
        let visible_end = get_u64(&visible_obj, "endIndex").max(visible_start);
        let gaps = compute_visible_repair_ranges(
            visible_start,
            visible_end,
            local_start,
            local_end,
            &ranges_from_value(local_obj.get("gapRanges")),
        );
        let mut repair_ranges = gaps;
        if get_str(&frame_obj, "kind") == "rejected" {
            if let Some(range_value) = frame_obj.get("repairRange") {
                let repair_start = get_u64(&obj_ref(range_value), "startIndex");
                let repair_end = get_u64(&obj_ref(range_value), "endIndex");
                if repair_end > repair_start {
                    repair_ranges.push((repair_start, repair_end));
                }
            }
        }
        repair_ranges = merge_gap_ranges(&repair_ranges);
        let applies = frame_end > frame_start;
        let policy_obj = obj(policy);
        let reason = if repair_ranges.is_empty() {
            "full-frame-apply"
        } else {
            "apply-with-visible-repair"
        };
        Ok(json!({
            "apply": applies,
            "reason": reason,
            "completeFrame": Value::Object(frame_obj),
            "repairRanges": ranges_to_value(&repair_ranges),
            "visibleRange": range(visible_start, visible_end),
            "localState": Value::Object(local_obj),
            "policy": policy_obj.get("sparseApply").cloned().unwrap_or(Value::Null),
        }))
    }
}

fn compute_visible_repair_ranges(
    visible_start: u64,
    visible_end: u64,
    local_start: u64,
    local_end: u64,
    local_gaps: &[(u64, u64)],
) -> Vec<(u64, u64)> {
    if visible_end <= visible_start {
        return Vec::new();
    }
    let mut missing = Vec::new();
    if local_start > visible_start {
        missing.push((visible_start, visible_end.min(local_start)));
    }
    missing.extend(collect_intersecting(local_gaps, visible_start, visible_end));
    if local_end < visible_end {
        missing.push((visible_start.max(local_end), visible_end));
    }
    merge_gap_ranges(&missing)
}

struct SparseBufferApply;

impl Operator for SparseBufferApply {
    fn name(&self) -> &'static str {
        "client.sparse_buffer.apply"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let plan = obj(input);
        let local = obj(plan.get("localState").cloned().unwrap_or_else(|| {
            json!({
                "startIndex": 0,
                "endIndex": 0,
                "gapRanges": [],
            })
        }));
        if !get_bool(&plan, "apply") {
            return Ok(json!({
                "applied": false,
                "reason": "plan rejected frame",
                "revision": get_u64(&local, "revision"),
                "startIndex": get_u64(&local, "startIndex"),
                "endIndex": get_u64(&local, "endIndex"),
                "gapRanges": local.get("gapRanges").cloned().unwrap_or_else(|| json!([])),
                "lines": local.get("lines").cloned().unwrap_or_else(|| json!([])),
                "cols": get_u64(&local, "cols"),
                "rows": get_u64(&local, "rows"),
                "cursorKeysApp": get_bool(&local, "cursorKeysApp"),
                "cursor": local.get("cursor").cloned().unwrap_or(Value::Null),
                "role": "client.sparse_buffer.apply",
            }));
        }
        let frame = obj(plan.get("completeFrame").cloned().unwrap_or_default());
        let local_revision = get_u64(&local, "revision");
        let frame_revision = get_u64(&frame, "revision");
        if frame_revision < local_revision {
            return Ok(json!({
                "applied": false,
                "reason": "stale-frame-rejected",
                "revision": local_revision,
                "startIndex": get_u64(&local, "startIndex"),
                "endIndex": get_u64(&local, "endIndex"),
                "gapRanges": local.get("gapRanges").cloned().unwrap_or_else(|| json!([])),
                "lines": local.get("lines").cloned().unwrap_or_else(|| json!([])),
                "cols": get_u64(&local, "cols"),
                "rows": get_u64(&local, "rows"),
                "cursorKeysApp": get_bool(&local, "cursorKeysApp"),
                "cursor": local.get("cursor").cloned().unwrap_or(Value::Null),
                "role": "client.sparse_buffer.apply",
            }));
        }
        let start = get_u64(&frame, "startIndex");
        let end = get_u64(&frame, "endIndex");
        let frame_lines = frame
            .get("lines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut merged_lines = local
            .get("lines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|line| {
                let line_index = get_u64(&obj_ref(line), "index");
                line_index < start || line_index >= end
            })
            .collect::<Vec<_>>();
        let mut seen_indexes = merged_lines
            .iter()
            .map(|line| get_u64(&obj_ref(line), "index"))
            .collect::<Vec<_>>();
        for line in frame_lines {
            let line_index = get_u64(&obj_ref(&line), "index");
            if !seen_indexes.contains(&line_index) {
                merged_lines.push(line);
                seen_indexes.push(line_index);
            } else if let Some(existing) = merged_lines
                .iter_mut()
                .find(|existing| get_u64(&obj_ref(existing), "index") == line_index)
            {
                *existing = line;
            }
        }
        merged_lines.sort_by_key(|line| get_u64(&obj_ref(line), "index"));
        let local_start = get_u64(&local, "startIndex");
        let local_end = get_u64(&local, "endIndex");
        let local_gaps = ranges_from_value(local.get("gapRanges"));
        let mut remaining_gaps = Vec::new();
        let local_empty = local_start == local_end
            && local_start == 0
            && merged_lines.is_empty()
            && local_gaps.is_empty();
        if local_empty && start > 0 {
            remaining_gaps.push((0, start));
        }
        for gap in local_gaps {
            let (gap_start, gap_end) = gap;
            if gap_end <= start || gap_start >= end {
                remaining_gaps.push(gap);
                continue;
            }
            if gap_start < start {
                remaining_gaps.push((gap_start, start));
            }
            if gap_end > end {
                remaining_gaps.push((end, gap_end));
            }
        }
        let revision = get_u64(&frame, "revision");
        let sparse_start = if local_empty {
            start
        } else {
            start.min(local_start)
        };
        Ok(json!({
            "applied": true,
            "revision": revision,
            "startIndex": sparse_start,
            "endIndex": end.max(local_end),
            "gapRanges": ranges_to_value(&merge_gap_ranges(&remaining_gaps)),
            "lines": merged_lines,
            "cols": get_u64(&frame, "cols"),
            "rows": get_u64(&frame, "rows"),
            "cursorKeysApp": get_bool(&frame, "cursorKeysApp"),
            "cursor": frame.get("cursor").cloned().unwrap_or(Value::Null),
            "updateKind": "patch",
            "role": "client.sparse_buffer.apply",
        }))
    }
}

struct BufferPlannerRequest;

impl Operator for BufferPlannerRequest {
    fn name(&self) -> &'static str {
        "client.buffer_planner.request"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let plan = obj(input);
        let ranges = plan
            .get("repairRanges")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(json!({
            "repairRanges": ranges,
            "status": if ranges.is_empty() { "none" } else { "pending" },
            "role": "client.buffer_planner.request",
        }))
    }
}

struct RendererWindowCommit;

impl Operator for RendererWindowCommit {
    fn name(&self) -> &'static str {
        "client.renderer_window.commit"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let sparse = values.first().cloned().unwrap_or_default();
        let visible = values.get(1).cloned().unwrap_or_default();
        let sparse_obj = obj(sparse);
        let lines = sparse_obj
            .get("lines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let visible_obj = obj(visible);
        let from = get_u64(&visible_obj, "startIndex");
        let to = get_u64(&visible_obj, "endIndex").max(from);
        let mut indexed_lines = HashMap::<u64, Value>::new();
        for line in lines {
            let index = get_u64(&obj_ref(&line), "index");
            indexed_lines.insert(index, line);
        }
        let mut window_lines = Vec::new();
        for index in from..to {
            window_lines.push(indexed_lines.get(&index).cloned().unwrap_or_else(|| {
                json!({
                    "index": index,
                    "cells": [],
                })
            }));
        }
        let mode = get_str(&visible_obj, "mode");
        Ok(json!({
            "startIndex": from,
            "endIndex": to,
            "mode": if mode.is_empty() { "follow" } else { mode },
            "revision": get_u64(&sparse_obj, "revision"),
            "renderBottomIndex": to,
            "lines": window_lines,
            "gapRanges": sparse_obj.get("gapRanges").cloned().unwrap_or_else(|| json!([])),
            "cols": get_u64(&sparse_obj, "cols"),
            "rows": get_u64(&sparse_obj, "rows"),
            "cursor": sparse_obj.get("cursor").cloned().unwrap_or(Value::Null),
            "role": "client.renderer_window.commit",
        }))
    }
}

struct DomRendererProject;

impl Operator for DomRendererProject {
    fn name(&self) -> &'static str {
        "client.dom_renderer.project"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let snapshot = obj(input);
        let lines = snapshot
            .get("lines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let text_lines = lines.iter().map(cells_to_text).collect::<Vec<_>>();
        Ok(json!({
            "rows": text_lines,
            "revision": get_u64(&snapshot, "revision"),
            "startIndex": get_u64(&snapshot, "startIndex"),
            "endIndex": get_u64(&snapshot, "endIndex"),
            "role": "client.dom_renderer.project",
        }))
    }
}

fn cells_to_text(line: &Value) -> String {
    let mut output = String::new();
    let cells = obj_ref(line)
        .get("cells")
        .cloned()
        .unwrap_or_else(|| json!([]));
    for cell in cells.as_array().into_iter().flat_map(|items| items.iter()) {
        let cell_obj = obj(cell.clone());
        let ch = get_u64(&cell_obj, "char");
        let width = get_u64(&cell_obj, "width");
        if width != 0 && ch >= 32 {
            if let Some(c) = char::from_u32(ch as u32) {
                output.push(c);
            }
        }
    }
    output.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Operators: android.input_dispatch
// ---------------------------------------------------------------------------

fn normalize_committed_text(input: Value) -> Value {
    let input = input.as_str().unwrap_or("");
    let text = input.replace("\r\n", "\n").to_string();
    let mut output = String::new();
    for ch in text.chars() {
        let code = ch as u32;
        if ch == '\n' || ch == '\r' {
            output.push(' ');
            continue;
        }
        if char::from_u32(0x3000) == Some(ch) {
            output.push(' ');
            continue;
        }
        if (0xff01..=0xff5e).contains(&code) {
            if let Some(c) = char::from_u32(code - 0xfee0) {
                output.push(c);
                continue;
            }
        }
        output.push(ch);
    }
    Value::String(output)
}

struct InputNormalizerNormalize;

impl Operator for InputNormalizerNormalize {
    fn name(&self) -> &'static str {
        "client.input_normalizer.normalize"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let text = match input {
            Value::String(text) => text,
            Value::Object(map) => get_str(&map, "text").to_string(),
            _ => String::new(),
        };
        Ok(json!({ "text": normalize_committed_text(Value::String(text)) }))
    }
}

fn split_utf8_chunks(input: &str, max_chunk_bytes: u64) -> Vec<String> {
    if max_chunk_bytes < 4 || input.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_bytes: usize = 0;
    let cap = max_chunk_bytes as usize;
    for ch in input.chars() {
        let mut buf = [0; 4];
        let encoded = ch.encode_utf8(&mut buf);
        let bytes = encoded.len();
        if current_bytes > 0 && current_bytes + bytes > cap {
            chunks.push(current.clone());
            current.clear();
            current_bytes = 0;
        }
        current.push(ch);
        current_bytes += bytes;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

struct ReliableInputPlan;

impl Operator for ReliableInputPlan {
    fn name(&self) -> &'static str {
        "client.reliable_input.plan"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Array
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let normalized = values.first().cloned().unwrap_or_else(|| json!({}));
        let text = normalized
            .as_str()
            .map(|value| value.to_string())
            .unwrap_or_else(|| get_str(&obj_ref(&normalized), "text").to_string());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let transport = obj(values.get(2).cloned().unwrap_or_default());
        let max_chunk_bytes =
            get_u64(&policy, "chunkBytes").pipe_or(TERMINAL_INPUT_CHUNK_BYTES as u64);
        let max_in_flight = get_u64(&policy, "maxInFlight")
            .pipe_or(TERMINAL_RELIABLE_INPUT_MAX_IN_FLIGHT as u64)
            as usize;
        let buffered_bytes = get_u64(&transport, "bufferedBytes");
        let backpressure_threshold = get_u64(&transport, "backpressureThreshold")
            .pipe_or(TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES);
        let ready = get_str(&transport, "state") == "ready" || get_bool(&transport, "ready");
        let backpressured = buffered_bytes >= backpressure_threshold;
        let chunks = split_utf8_chunks(&text, max_chunk_bytes);
        let state = if !ready {
            "blocked"
        } else if backpressured {
            "backpressured"
        } else if chunks.is_empty() {
            "idle"
        } else {
            "queued"
        };
        let slots = if ready && !backpressured {
            max_in_flight
        } else {
            0
        };
        Ok(json!({
            "chunks": chunks,
            "inFlightSlots": slots,
            "state": state,
            "role": "client.reliable_input.plan",
        }))
    }
}

struct ReliableInputEmit;

impl Operator for ReliableInputEmit {
    fn name(&self) -> &'static str {
        "client.reliable_input.emit"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let batch = obj(input);
        let chunks = batch
            .get("chunks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let state = get_str(&batch, "state");
        let slots = get_u64(&batch, "inFlightSlots") as usize;
        let sends = if state == "queued" {
            chunks
                .into_iter()
                .take(slots.max(1))
                .enumerate()
                .map(|(index, chunk)| {
                    json!({
                        "type": "input",
                        "payload": {
                            "version": 1,
                            "seq": format!("input:{}", index),
                            "data": chunk,
                            "attempt": 1,
                        },
                    })
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        Ok(json!({
            "sends": sends,
            "droppedToBackpressure": state == "backpressured" || state == "blocked",
            "role": "client.reliable_input.emit",
        }))
    }
}
