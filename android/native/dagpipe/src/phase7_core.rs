//! DAGpipe Phase 7 operators for release promotion, update lifecycle, and
//! observability/debug.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const RELEASE_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/release-runtime-promotion.graph.json");
const UPDATE_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/release-update-lifecycle.graph.json");
const DEBUG_GRAPH_JSON: &str = include_str!("../../../docs/dagpipe/observability-debug.graph.json");

pub const RELEASE_GRAPH_ID: &str = "release.runtime_promotion";
pub const UPDATE_GRAPH_ID: &str = "release.update_lifecycle";
pub const DEBUG_GRAPH_ID: &str = "observability.debug";
pub const PHASE7_GRAPH_VERSION: &str = "0.1";

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
    register!(ReleaseVerifyDigest);
    register!(ReleasePromoteDaemonArtifact);
    register!(ReleaseInstallRuntime);
    register!(ReleaseStartRuntime);
    register!(UpdateCheck);
    register!(UpdateDownload);
    register!(UpdateVerifyDownload);
    register!(UpdateInstallClient);
    register!(DebugAuthorize);
    register!(DebugSample);
    register!(DebugStore);
    register!(DebugExport);
    register!(DebugCleanup);
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

pub fn compile_phase7_graphs() -> Result<Vec<String>, CompileError> {
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    compile(
        parse_graph_json(RELEASE_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    compile(
        parse_graph_json(UPDATE_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    compile(
        parse_graph_json(DEBUG_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    Ok(vec![
        format!("{RELEASE_GRAPH_ID}@{PHASE7_GRAPH_VERSION}"),
        format!("{UPDATE_GRAPH_ID}@{PHASE7_GRAPH_VERSION}"),
        format!("{DEBUG_GRAPH_ID}@{PHASE7_GRAPH_VERSION}"),
    ])
}

pub fn run_phase7_release_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        RELEASE_GRAPH_JSON,
        RELEASE_GRAPH_ID,
        PHASE7_GRAPH_VERSION,
    )
}

pub fn run_phase7_update_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        UPDATE_GRAPH_JSON,
        UPDATE_GRAPH_ID,
        PHASE7_GRAPH_VERSION,
    )
}

pub fn run_phase7_debug_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        DEBUG_GRAPH_JSON,
        DEBUG_GRAPH_ID,
        PHASE7_GRAPH_VERSION,
    )
}

struct ReleaseVerifyDigest;

impl Operator for ReleaseVerifyDigest {
    fn name(&self) -> &'static str {
        "release.update_artifact.verify"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let artifact = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let expected = get_str(&policy, "expectedSha256");
        if expected.is_empty() {
            return Err("release policy requires expectedSha256".into());
        }
        let actual = get_str(&artifact, "sha256");
        if actual.is_empty() {
            return Err("release artifact digest missing".into());
        }
        if actual != expected {
            return Err("release artifact digest mismatch".into());
        }
        Ok(json!({
            "artifact": get_str(&artifact, "name"),
            "sha256": actual,
            "state": "verified",
        }))
    }
}

struct ReleasePromoteDaemonArtifact;

impl Operator for ReleasePromoteDaemonArtifact {
    fn name(&self) -> &'static str {
        "release.daemon_artifact.promote"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let verified = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "artifact": get_str(&verified, "artifact"),
            "state": "promoted",
        }))
    }
}

struct ReleaseInstallRuntime;

impl Operator for ReleaseInstallRuntime {
    fn name(&self) -> &'static str {
        "release.runtime_home.install"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let promoted = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "artifact": get_str(&promoted, "artifact"),
            "state": "installed",
        }))
    }
}

struct ReleaseStartRuntime;

impl Operator for ReleaseStartRuntime {
    fn name(&self) -> &'static str {
        "daemon.runtime_entry.start"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let installed = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "artifact": get_str(&installed, "artifact"),
            "state": "started",
        }))
    }
}

struct UpdateCheck;

impl Operator for UpdateCheck {
    fn name(&self) -> &'static str {
        "release.update_artifact.check"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let check = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let version = get_str(&check, "version");
        if version.is_empty() {
            return Err("update check requires version".into());
        }
        Ok(json!({
            "version": version,
            "hasUpdate": get_bool(&policy, "allowUpdate"),
            "sha256": get_str(&check, "sha256"),
            "state": "checked",
        }))
    }
}

struct UpdateDownload;

impl Operator for UpdateDownload {
    fn name(&self) -> &'static str {
        "release.update_artifact.download"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let available = obj(inputs(input).first().cloned().unwrap_or_default());
        if !get_bool(&available, "hasUpdate") {
            return Err("update is not available".into());
        }
        Ok(json!({
            "version": get_str(&available, "version"),
            "sha256": get_str(&available, "sha256"),
            "state": "downloaded",
        }))
    }
}

struct UpdateVerifyDownload;

impl Operator for UpdateVerifyDownload {
    fn name(&self) -> &'static str {
        "release.update_artifact.verify_download"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let downloaded = obj(inputs(input).first().cloned().unwrap_or_default());
        if get_str(&downloaded, "sha256").is_empty() {
            return Err("downloaded update digest missing".into());
        }
        Ok(json!({
            "version": get_str(&downloaded, "version"),
            "state": "verified",
        }))
    }
}

struct UpdateInstallClient;

impl Operator for UpdateInstallClient {
    fn name(&self) -> &'static str {
        "release.update_artifact.install_client"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let verified = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "version": get_str(&verified, "version"),
            "state": "installed",
        }))
    }
}

struct DebugAuthorize;

impl Operator for DebugAuthorize {
    fn name(&self) -> &'static str {
        "observability.debug_channel.authorize"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let policy = obj(inputs(input).first().cloned().unwrap_or_default());
        if !get_bool(&policy, "allowDebug") {
            return Err("debug channel denied".into());
        }
        Ok(json!({ "leaseId": "debug-lease-1", "state": "authorized" }))
    }
}

struct DebugSample;

impl Operator for DebugSample {
    fn name(&self) -> &'static str {
        "observability.debug_channel.sample"
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
        let lease = obj(values.get(1).cloned().unwrap_or_default());
        if get_str(&lease, "state") != "authorized" {
            return Err("debug sample requires authorized lease".into());
        }
        Ok(json!({
            "sample": request.get("sample").cloned().unwrap_or(Value::Null),
            "state": "sampled",
        }))
    }
}

struct DebugStore;

impl Operator for DebugStore {
    fn name(&self) -> &'static str {
        "client.debug_hub.store"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let sample = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sample": sample.get("sample").cloned().unwrap_or(Value::Null),
            "state": "stored",
        }))
    }
}

struct DebugExport;

impl Operator for DebugExport {
    fn name(&self) -> &'static str {
        "client.debug_hub.export"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let store = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sample": store.get("sample").cloned().unwrap_or(Value::Null),
            "state": "exported",
        }))
    }
}

struct DebugCleanup;

impl Operator for DebugCleanup {
    fn name(&self) -> &'static str {
        "client.debug_hub.cleanup"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let store = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "cleaned": true,
            "state": "cleaned",
            "sample": store.get("sample").cloned().unwrap_or(Value::Null),
        }))
    }
}
