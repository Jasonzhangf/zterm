//! DAGpipe Phase 4 operators for remote-window stream and overlay projection.
//!
//! These operators consume ARC values only. They do not own desktop capture,
//! transport, terminal mirror, layout, or UI truth.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const REMOTE_WINDOW_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/remote-window-stream-overlay.graph.json");

pub const REMOTE_WINDOW_GRAPH_ID: &str = "remote.window_stream_overlay";
pub const PHASE4_GRAPH_VERSION: &str = "0.1";

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

fn json_array(value: Option<&Value>) -> Vec<Value> {
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
    register!(OverlayRequestCatalog);
    register!(DaemonListWindows);
    register!(OverlayProjectDirectory);
    register!(OverlayStartStream);
    register!(OverlayAdjustQuality);
    register!(DaemonPlanBudget);
    register!(DaemonStartCapture);
    register!(DaemonEncodeSend);
    register!(OverlayReceiveFrames);
    register!(OverlayProjectOverlay);
    register!(OverlayClassifyTouch);
    register!(DaemonMapInput);
    register!(DaemonInjectInput);
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
        for input_id in graph_value
            .get("inputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = input_id.get("id").and_then(Value::as_str) {
                inputs_map
                    .entry(id.to_string())
                    .or_insert_with(|| json!({}));
            }
        }
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
            for (arc_id, arc) in result.outputs {
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

pub fn compile_phase4_graphs() -> Result<Vec<String>, CompileError> {
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    compile(
        parse_graph_json(REMOTE_WINDOW_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    Ok(vec![format!(
        "{REMOTE_WINDOW_GRAPH_ID}@{PHASE4_GRAPH_VERSION}"
    )])
}

pub fn run_phase4_remote_window_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        REMOTE_WINDOW_GRAPH_JSON,
        REMOTE_WINDOW_GRAPH_ID,
        PHASE4_GRAPH_VERSION,
    )
}

struct OverlayRequestCatalog;

impl Operator for OverlayRequestCatalog {
    fn name(&self) -> &'static str {
        "client.remote_window_overlay.request_catalog"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let request = obj(inputs(input).first().cloned().unwrap_or_default());
        let request_id = get_str(&request, "requestId").to_string();
        if request_id.is_empty() {
            return Err("remote window catalog request requires requestId".into());
        }
        Ok(json!({
            "requestId": request_id,
            "windows": request.get("windows").cloned().unwrap_or_else(|| json!([])),
            "state": "requested",
        }))
    }
}

struct DaemonListWindows;

impl Operator for DaemonListWindows {
    fn name(&self) -> &'static str {
        "daemon.remote_window_stream.list_windows"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let request = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "requestId": get_str(&request, "requestId"),
            "windows": request.get("windows").cloned().unwrap_or_else(|| json!([])),
            "state": "listed",
        }))
    }
}

struct OverlayProjectDirectory;

impl Operator for OverlayProjectDirectory {
    fn name(&self) -> &'static str {
        "client.remote_window_overlay.project_directory"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let catalog = obj(inputs(input).first().cloned().unwrap_or_default());
        let windows = json_array(catalog.get("windows"));
        if windows.is_empty() {
            return Err("remote window catalog has no windows".into());
        }
        Ok(json!({
            "requestId": get_str(&catalog, "requestId"),
            "windows": windows,
            "state": "ready",
        }))
    }
}

struct OverlayStartStream;

impl Operator for OverlayStartStream {
    fn name(&self) -> &'static str {
        "client.remote_window_overlay.start_stream"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let intent = json_object(values.first().cloned().unwrap_or_default());
        let directory = json_object(values.get(1).cloned().unwrap_or_default());
        let policy = json_object(values.get(2).cloned().unwrap_or_default());
        let target_id = get_str(&intent, "targetId").to_string();
        if target_id.is_empty() {
            return Err("stream start intent requires targetId".into());
        }
        if !get_bool(&policy, "allowStream") {
            return Err("remote window stream denied by policy".into());
        }
        let known = json_array(directory.get("windows"))
            .into_iter()
            .any(|item| {
                item.as_str() == Some(&target_id)
                    || item.get("id").and_then(Value::as_str) == Some(&target_id)
            });
        if !known {
            return Err("stream target is not in overlay directory".into());
        }
        Ok(json!({
            "targetId": target_id,
            "requestId": get_str(&intent, "requestId"),
            "state": "start-requested",
        }))
    }
}

struct OverlayAdjustQuality;

impl Operator for OverlayAdjustQuality {
    fn name(&self) -> &'static str {
        "client.remote_window_overlay.adjust_quality"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let quality = json_object(values.first().cloned().unwrap_or_default());
        let policy = json_object(values.get(1).cloned().unwrap_or_default());
        if !get_bool(&policy, "allowQuality") {
            return Err("remote window quality denied by policy".into());
        }
        Ok(json!({
            "targetId": get_str(&quality, "targetId"),
            "mode": get_str(&quality, "mode"),
            "state": "requested",
        }))
    }
}

fn json_object(value: Value) -> Map<String, Value> {
    obj(value)
}

struct DaemonPlanBudget;

impl Operator for DaemonPlanBudget {
    fn name(&self) -> &'static str {
        "daemon.remote_window_stream.plan_budget"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let quality = json_object(values.first().cloned().unwrap_or_default());
        let policy = json_object(values.get(1).cloned().unwrap_or_default());
        Ok(json!({
            "targetId": get_str(&quality, "targetId"),
            "mode": get_str(&quality, "mode"),
            "fps": policy.get("fps").cloned().unwrap_or_else(|| json!(30)),
            "state": "planned",
        }))
    }
}

struct DaemonStartCapture;

impl Operator for DaemonStartCapture {
    fn name(&self) -> &'static str {
        "daemon.remote_window_stream.start_capture"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let command = json_object(values.first().cloned().unwrap_or_default());
        let budget = json_object(values.get(1).cloned().unwrap_or_default());
        let target_id = get_str(&command, "targetId").to_string();
        if target_id.is_empty() {
            return Err("capture requires stream start command".into());
        }
        Ok(json!({
            "targetId": target_id,
            "fps": budget.get("fps").cloned().unwrap_or_else(|| json!(30)),
            "state": "capturing",
        }))
    }
}

struct DaemonEncodeSend;

impl Operator for DaemonEncodeSend {
    fn name(&self) -> &'static str {
        "daemon.remote_window_stream.encode_send"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let capture = json_object(values.first().cloned().unwrap_or_default());
        let _policy = json_object(values.get(1).cloned().unwrap_or_default());
        Ok(json!({
            "targetId": get_str(&capture, "targetId"),
            "frames": capture.get("frames").cloned().unwrap_or_else(|| json!([])),
            "state": "encoded",
        }))
    }
}

struct OverlayReceiveFrames;

impl Operator for OverlayReceiveFrames {
    fn name(&self) -> &'static str {
        "client.remote_window_overlay.receive_frames"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let frames = json_object(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "targetId": get_str(&frames, "targetId"),
            "frames": frames.get("frames").cloned().unwrap_or_else(|| json!([])),
            "state": "received",
        }))
    }
}

struct OverlayProjectOverlay;

impl Operator for OverlayProjectOverlay {
    fn name(&self) -> &'static str {
        "client.remote_window_overlay.project_overlay"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let received = json_object(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "targetId": get_str(&received, "targetId"),
            "frames": received.get("frames").cloned().unwrap_or_else(|| json!([])),
            "state": "projected",
        }))
    }
}

struct OverlayClassifyTouch;

impl Operator for OverlayClassifyTouch {
    fn name(&self) -> &'static str {
        "client.remote_window_overlay.classify_touch"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let action = json_object(inputs(input).first().cloned().unwrap_or_default());
        if get_str(&action, "kind").is_empty() {
            return Err("remote window touch action requires kind".into());
        }
        Ok(json!({
            "kind": get_str(&action, "kind"),
            "x": action.get("x").cloned().unwrap_or_else(|| json!(0)),
            "y": action.get("y").cloned().unwrap_or_else(|| json!(0)),
            "state": "classified",
        }))
    }
}

struct DaemonMapInput;

impl Operator for DaemonMapInput {
    fn name(&self) -> &'static str {
        "daemon.remote_window_stream.map_input"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let action = json_object(values.first().cloned().unwrap_or_default());
        let capture = json_object(values.get(1).cloned().unwrap_or_default());
        Ok(json!({
            "targetId": get_str(&capture, "targetId"),
            "kind": get_str(&action, "kind"),
            "sourceX": action.get("x").cloned().unwrap_or_else(|| json!(0)),
            "sourceY": action.get("y").cloned().unwrap_or_else(|| json!(0)),
            "state": "mapped",
        }))
    }
}

struct DaemonInjectInput;

impl Operator for DaemonInjectInput {
    fn name(&self) -> &'static str {
        "daemon.remote_window_stream.inject_input"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let source = json_object(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "targetId": get_str(&source, "targetId"),
            "kind": get_str(&source, "kind"),
            "injected": true,
            "state": "injected",
        }))
    }
}
