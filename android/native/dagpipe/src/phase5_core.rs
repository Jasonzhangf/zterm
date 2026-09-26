//! DAGpipe Phase 5 operators for Android session shell and preview projection.
//!
//! These operators consume ARC values only and never own transport, terminal
//! body, buffer, renderer, or UI truth.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const SHELL_LIFECYCLE_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-session-shell-lifecycle.graph.json");
const PREVIEW_LATTICE_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/android-session-preview-lattice.graph.json");

pub const SHELL_LIFECYCLE_GRAPH_ID: &str = "android.session_shell_lifecycle";
pub const PREVIEW_LATTICE_GRAPH_ID: &str = "android.session_preview_lattice";
pub const PHASE5_GRAPH_VERSION: &str = "0.1";

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

fn make_registry() -> Registry {
    let mut registry = Registry::default();
    macro_rules! register {
        ($op:expr) => {
            registry.register($op).expect("register operator")
        };
    }
    register!(ShellOpenTab);
    register!(SessionActivate);
    register!(SessionSubscribe);
    register!(ShellProject);
    register!(ShellProjectQuickbar);
    register!(ShellProjectCopy);
    register!(KeyboardProjectLift);
    register!(PreviewOpen);
    register!(PreviewProjectLattice);
    register!(PreviewSelectCell);
    register!(PreviewApplySelectedCell);
    register!(PreviewPanFocus);
    register!(PreviewApplyPannedFocus);
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

pub fn compile_phase5_graphs() -> Result<Vec<String>, CompileError> {
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    compile(
        parse_graph_json(SHELL_LIFECYCLE_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    compile(
        parse_graph_json(PREVIEW_LATTICE_GRAPH_JSON)?,
        &registry,
        &capabilities,
    )?;
    Ok(vec![
        format!("{SHELL_LIFECYCLE_GRAPH_ID}@{PHASE5_GRAPH_VERSION}"),
        format!("{PREVIEW_LATTICE_GRAPH_ID}@{PHASE5_GRAPH_VERSION}"),
    ])
}

pub fn run_phase5_shell_lifecycle_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        SHELL_LIFECYCLE_GRAPH_JSON,
        SHELL_LIFECYCLE_GRAPH_ID,
        PHASE5_GRAPH_VERSION,
    )
}

pub fn run_phase5_preview_lattice_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        PREVIEW_LATTICE_GRAPH_JSON,
        PREVIEW_LATTICE_GRAPH_ID,
        PHASE5_GRAPH_VERSION,
    )
}

struct ShellOpenTab;

impl Operator for ShellOpenTab {
    fn name(&self) -> &'static str {
        "client.app_shell.open_tab"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let intent = obj(inputs(input).first().cloned().unwrap_or_default());
        let session_id = get_str(&intent, "sessionId").to_string();
        if session_id.is_empty() {
            return Err("open tab requires sessionId".into());
        }
        Ok(json!({ "sessionId": session_id, "state": "opened" }))
    }
}

struct SessionActivate;

impl Operator for SessionActivate {
    fn name(&self) -> &'static str {
        "client.session_runtime.activate"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let tab = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&tab, "sessionId"),
            "state": "active",
        }))
    }
}

struct SessionSubscribe;

impl Operator for SessionSubscribe {
    fn name(&self) -> &'static str {
        "client.session_runtime.subscribe"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let session = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&session, "sessionId"),
            "bodySubscribed": true,
            "state": "subscribed",
        }))
    }
}

struct ShellProject;

impl Operator for ShellProject {
    fn name(&self) -> &'static str {
        "client.terminal_shell.project"
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
        let shell_state = obj(values.get(1).cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&subscription, "sessionId"),
            "visible": shell_state.get("visible").cloned().unwrap_or(json!(true)),
            "state": "projected",
        }))
    }
}

struct ShellProjectQuickbar;

impl Operator for ShellProjectQuickbar {
    fn name(&self) -> &'static str {
        "client.terminal_shell.project_quickbar"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let shell_projection = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&shell_projection, "sessionId"),
            "state": "projected",
        }))
    }
}

struct PreviewOpen;

impl Operator for PreviewOpen {
    fn name(&self) -> &'static str {
        "client.session_drawer_preview.open"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let intent = obj(inputs(input).first().cloned().unwrap_or_default());
        if get_str(&intent, "sessionId").is_empty() {
            return Err("preview open requires sessionId".into());
        }
        Ok(json!({
            "sessionId": get_str(&intent, "sessionId"),
            "state": "open",
        }))
    }
}

struct PreviewProjectLattice;

impl Operator for PreviewProjectLattice {
    fn name(&self) -> &'static str {
        "client.session_drawer_preview.project_lattice"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let preview = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&preview, "sessionId"),
            "cells": preview.get("cells").cloned().unwrap_or_else(|| json!([])),
            "state": "projected",
        }))
    }
}

struct PreviewSelectCell;

impl Operator for PreviewSelectCell {
    fn name(&self) -> &'static str {
        "client.session_drawer_preview.select_cell"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let lattice = obj(values.first().cloned().unwrap_or_default());
        let select = obj(values.get(1).cloned().unwrap_or_default());
        let cell = get_str(&select, "cellId").to_string();
        Ok(json!({
            "sessionId": get_str(&lattice, "sessionId"),
            "cellId": cell,
            "state": if cell.is_empty() { "skipped" } else { "selected" },
        }))
    }
}

struct PreviewApplySelectedCell;

impl Operator for PreviewApplySelectedCell {
    fn name(&self) -> &'static str {
        "client.session_drawer_preview.apply_selected_cell"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let selected = obj(inputs(input).first().cloned().unwrap_or_default());
        if get_str(&selected, "state") == "skipped" {
            return Ok(json!({
                "sessionId": get_str(&selected, "sessionId"),
                "cellId": get_str(&selected, "cellId"),
                "state": "skipped",
            }));
        }
        Ok(json!({
            "sessionId": get_str(&selected, "sessionId"),
            "cellId": get_str(&selected, "cellId"),
            "state": "applied",
        }))
    }
}

struct PreviewPanFocus;

impl Operator for PreviewPanFocus {
    fn name(&self) -> &'static str {
        "client.session_drawer_preview.pan_focus"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let lattice = obj(values.first().cloned().unwrap_or_default());
        let pan = obj(values.get(1).cloned().unwrap_or_default());
        let direction = get_str(&pan, "direction").to_string();
        Ok(json!({
            "sessionId": get_str(&lattice, "sessionId"),
            "direction": direction,
            "state": if direction.is_empty() { "skipped" } else { "panned" },
        }))
    }
}

struct PreviewApplyPannedFocus;

impl Operator for PreviewApplyPannedFocus {
    fn name(&self) -> &'static str {
        "client.session_drawer_preview.apply_panned_focus"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let panned = obj(inputs(input).first().cloned().unwrap_or_default());
        if get_str(&panned, "state") == "skipped" {
            return Ok(json!({
                "sessionId": get_str(&panned, "sessionId"),
                "direction": get_str(&panned, "direction"),
                "state": "skipped",
            }));
        }
        Ok(json!({
            "sessionId": get_str(&panned, "sessionId"),
            "direction": get_str(&panned, "direction"),
            "state": "applied",
        }))
    }
}

struct ShellProjectCopy;

impl Operator for ShellProjectCopy {
    fn name(&self) -> &'static str {
        "client.terminal_shell.project_copy"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let shell_projection = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&shell_projection, "sessionId"),
            "state": "projected",
        }))
    }
}

struct KeyboardProjectLift;

impl Operator for KeyboardProjectLift {
    fn name(&self) -> &'static str {
        "client.terminal_shell.project_keyboard"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let shell_projection = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&shell_projection, "sessionId"),
            "state": "projected",
        }))
    }
}
