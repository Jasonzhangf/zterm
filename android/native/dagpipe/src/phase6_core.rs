//! DAGpipe Phase 6 operators for client composition/plugin, control routing,
//! and config sharing.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const COMPOSITION_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-composition-plugin.graph.json");
const CONTROL_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-control-command.graph.json");
const CONFIG_EXPORT_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-config-export.graph.json");
const CONFIG_IMPORT_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-config-import.graph.json");

pub const COMPOSITION_GRAPH_ID: &str = "android.composition_plugin";
pub const CONTROL_GRAPH_ID: &str = "android.control_command";
pub const CONFIG_EXPORT_GRAPH_ID: &str = "android.config_export";
pub const CONFIG_IMPORT_GRAPH_ID: &str = "android.config_import";
pub const PHASE6_GRAPH_VERSION: &str = "0.1";

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

fn make_registry() -> Registry {
    let mut registry = Registry::default();
    macro_rules! register {
        ($op:expr) => {
            registry.register($op).expect("register operator")
        };
    }
    register!(CompositionValidatePorts);
    register!(CompositionCompose);
    register!(PluginReadManifest);
    register!(PluginRegisterCapabilities);
    register!(PluginRegisterUISlots);
    register!(PluginActivate);
    register!(ControlAuthenticate);
    register!(ControlGate);
    register!(ControlRoute);
    register!(ControlExecute);
    register!(ConfigValidateExport);
    register!(ConfigExport);
    register!(ConfigValidateImport);
    register!(ConfigImport);
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

pub fn compile_phase6_graphs() -> Result<Vec<String>, CompileError> {
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    compile(
        parse_graph_json(COMPOSITION_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    compile(
        parse_graph_json(CONTROL_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    compile(
        parse_graph_json(CONFIG_EXPORT_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    compile(
        parse_graph_json(CONFIG_IMPORT_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    Ok(vec![
        format!("{COMPOSITION_GRAPH_ID}@{PHASE6_GRAPH_VERSION}"),
        format!("{CONTROL_GRAPH_ID}@{PHASE6_GRAPH_VERSION}"),
        format!("{CONFIG_EXPORT_GRAPH_ID}@{PHASE6_GRAPH_VERSION}"),
        format!("{CONFIG_IMPORT_GRAPH_ID}@{PHASE6_GRAPH_VERSION}"),
    ])
}

pub fn run_phase6_composition_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        COMPOSITION_GRAPH_JSON,
        COMPOSITION_GRAPH_ID,
        PHASE6_GRAPH_VERSION,
    )
}

pub fn run_phase6_control_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        CONTROL_GRAPH_JSON,
        CONTROL_GRAPH_ID,
        PHASE6_GRAPH_VERSION,
    )
}

pub fn run_phase6_config_export_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        CONFIG_EXPORT_GRAPH_JSON,
        CONFIG_EXPORT_GRAPH_ID,
        PHASE6_GRAPH_VERSION,
    )
}

pub fn run_phase6_config_import_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        CONFIG_IMPORT_GRAPH_JSON,
        CONFIG_IMPORT_GRAPH_ID,
        PHASE6_GRAPH_VERSION,
    )
}

struct CompositionValidatePorts;

impl Operator for CompositionValidatePorts {
    fn name(&self) -> &'static str {
        "client.composition_root.validate_ports"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let request = obj(inputs(input).first().cloned().unwrap_or_default());
        let runtime_id = get_str(&request, "runtimeId").to_string();
        if runtime_id.is_empty() {
            return Err("composition request requires runtimeId".into());
        }
        Ok(json!({
            "runtimeId": runtime_id,
            "ports": request.get("ports").cloned().unwrap_or_else(|| json!([])),
            "state": "validated",
        }))
    }
}

struct CompositionCompose;

impl Operator for CompositionCompose {
    fn name(&self) -> &'static str {
        "client.composition_root.compose"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validated = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "runtimeId": get_str(&validated, "runtimeId"),
            "state": "composed",
        }))
    }
}

struct PluginReadManifest;

impl Operator for PluginReadManifest {
    fn name(&self) -> &'static str {
        "client.plugin_host.read_manifest"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let _runtime = obj(values.first().cloned().unwrap_or_default());
        let manifest = obj(values.get(1).cloned().unwrap_or_default());
        let plugin_id = get_str(&manifest, "pluginId").to_string();
        if plugin_id.is_empty() {
            return Err("plugin manifest requires pluginId".into());
        }
        Ok(json!({
            "pluginId": plugin_id,
            "capabilities": manifest.get("capabilities").cloned().unwrap_or_else(|| json!([])),
            "uiSlots": manifest.get("uiSlots").cloned().unwrap_or_else(|| json!([])),
            "state": "read",
        }))
    }
}

struct PluginRegisterCapabilities;

impl Operator for PluginRegisterCapabilities {
    fn name(&self) -> &'static str {
        "client.plugin_host.register_capabilities"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let manifest = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "pluginId": get_str(&manifest, "pluginId"),
            "capabilities": manifest.get("capabilities").cloned().unwrap_or_else(|| json!([])),
            "uiSlots": manifest.get("uiSlots").cloned().unwrap_or_else(|| json!([])),
            "state": "registered",
        }))
    }
}

struct PluginRegisterUISlots;

impl Operator for PluginRegisterUISlots {
    fn name(&self) -> &'static str {
        "client.plugin_host.register_ui_slots"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let capability = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "pluginId": get_str(&capability, "pluginId"),
            "uiSlots": capability.get("uiSlots").cloned().unwrap_or_else(|| json!([])),
            "state": "registered",
        }))
    }
}

struct PluginActivate;

impl Operator for PluginActivate {
    fn name(&self) -> &'static str {
        "client.plugin_host.activate"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let slots = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "pluginId": get_str(&slots, "pluginId"),
            "uiSlots": slots.get("uiSlots").cloned().unwrap_or_else(|| json!([])),
            "state": "active",
        }))
    }
}

struct ControlAuthenticate;

impl Operator for ControlAuthenticate {
    fn name(&self) -> &'static str {
        "client.control_center.authenticate"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let request = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let command_id = get_str(&request, "commandId").to_string();
        if command_id.is_empty() {
            return Err("control request requires commandId".into());
        }
        Ok(json!({
            "commandId": command_id,
            "state": "authenticated",
            "authenticated": get_bool(&policy, "allowControl"),
            "allowed": get_bool(&policy, "allowControl"),
            "owner": get_str(&request, "owner"),
            "payload": request.get("payload").cloned().unwrap_or_else(|| json!({})),
        }))
    }
}

struct ControlGate;

impl Operator for ControlGate {
    fn name(&self) -> &'static str {
        "client.control_center.gate"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let auth = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        if !get_bool(&policy, "allowControl") || !get_bool(&auth, "authenticated") {
            return Err("control command denied by capability policy".into());
        }
        Ok(json!({
            "commandId": get_str(&auth, "commandId"),
            "state": "gated",
            "owner": get_str(&auth, "owner"),
            "payload": auth.get("payload").cloned().unwrap_or_else(|| json!({})),
        }))
    }
}

struct ControlRoute;

impl Operator for ControlRoute {
    fn name(&self) -> &'static str {
        "client.control_center.route"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let gated = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "commandId": get_str(&gated, "commandId"),
            "owner": get_str(&gated, "owner"),
            "state": "routed",
        }))
    }
}

struct ControlExecute;

impl Operator for ControlExecute {
    fn name(&self) -> &'static str {
        "client.control_center.execute"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let routed = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "commandId": get_str(&routed, "commandId"),
            "state": "completed",
        }))
    }
}

struct ConfigValidateExport;

impl Operator for ConfigValidateExport {
    fn name(&self) -> &'static str {
        "settings.config_transfer.validate_export"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let request = obj(inputs(input).first().cloned().unwrap_or_default());
        let config_id = get_str(&request, "configId").to_string();
        if config_id.is_empty() {
            return Err("config export requires configId".into());
        }
        Ok(json!({ "configId": config_id, "state": "validated" }))
    }
}

struct ConfigExport;

impl Operator for ConfigExport {
    fn name(&self) -> &'static str {
        "settings.config_transfer.export"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validation = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "configId": get_str(&validation, "configId"),
            "exported": true,
            "state": "exported",
        }))
    }
}

struct ConfigValidateImport;

impl Operator for ConfigValidateImport {
    fn name(&self) -> &'static str {
        "connections.config_share.validate_import"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let request = obj(inputs(input).first().cloned().unwrap_or_default());
        let config_id = get_str(&request, "configId").to_string();
        if config_id.is_empty() {
            return Err("config import requires configId".into());
        }
        Ok(json!({ "configId": config_id, "state": "validated" }))
    }
}

struct ConfigImport;

impl Operator for ConfigImport {
    fn name(&self) -> &'static str {
        "connections.config_share.import"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validation = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "configId": get_str(&validation, "configId"),
            "imported": true,
            "state": "imported",
        }))
    }
}
