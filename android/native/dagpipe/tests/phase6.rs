use serde_json::{json, Value};

fn run_composition(input: Value) -> Value {
    zterm_dagpipe::phase6_core::run_phase6_composition_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_control(input: Value) -> Value {
    zterm_dagpipe::phase6_core::run_phase6_control_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_config(input: Value) -> Value {
    zterm_dagpipe::phase6_core::run_phase6_config_export_json(
        serde_json::to_string(&input).unwrap(),
    )
    .unwrap()
}

fn run_config_import(input: Value) -> Value {
    zterm_dagpipe::phase6_core::run_phase6_config_import_json(
        serde_json::to_string(&input).unwrap(),
    )
    .unwrap()
}

#[test]
fn compiles_phase6_graphs() {
    let graphs = zterm_dagpipe::phase6_core::compile_phase6_graphs().unwrap();
    assert_eq!(
        graphs,
        vec![
            "android.composition_plugin@0.1",
            "android.control_command@0.1",
            "android.config_export@0.1",
            "android.config_import@0.1",
        ]
    );
}

#[test]
fn composition_and_plugin_activate_plugins() {
    let result = run_composition(json!({
        "execution_id": "phase6-compose",
        "attempt_id": "1",
        "inputs": {
            "arc.composition_request": { "runtimeId": "rt-1", "ports": ["debug"] },
            "arc.plugin_manifest": {
                "pluginId": "p1",
                "capabilities": ["quickbar"],
                "uiSlots": ["terminal.quickbar"],
            },
        },
    }));
    assert_eq!(result["ok"], true, "phase6 compose failed: {result}");
    assert_eq!(
        result["outputs"]["arc.activated_plugins"]["state"],
        "active"
    );
    assert_eq!(
        result["outputs"]["arc.activated_plugins"]["uiSlots"],
        json!(["terminal.quickbar"])
    );
}

#[test]
fn control_command_routes_and_executes_when_allowed() {
    let result = run_control(json!({
        "execution_id": "phase6-control",
        "attempt_id": "1",
        "inputs": {
            "arc.control_request": { "commandId": "cmd-1", "owner": "settings" },
            "arc.control_policy": { "allowControl": true },
        },
    }));
    assert_eq!(result["ok"], true, "phase6 control failed: {result}");
    assert_eq!(
        result["outputs"]["arc.control_result"]["state"],
        "completed"
    );
    assert_eq!(
        result["outputs"]["arc.control_result"]["commandId"],
        "cmd-1"
    );
}

#[test]
fn control_command_denied_when_policy_forbids() {
    let result = run_control(json!({
        "execution_id": "phase6-control-deny",
        "attempt_id": "1",
        "inputs": {
            "arc.control_request": { "commandId": "cmd-1", "owner": "settings" },
            "arc.control_policy": { "allowControl": false },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn composition_rejects_missing_runtime_id() {
    let result = run_composition(json!({
        "execution_id": "phase6-compose-invalid",
        "attempt_id": "1",
        "inputs": {
            "arc.composition_request": {},
            "arc.plugin_manifest": { "pluginId": "p1" },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn control_rejects_missing_command_id() {
    let result = run_control(json!({
        "execution_id": "phase6-control-invalid",
        "attempt_id": "1",
        "inputs": {
            "arc.control_request": {},
            "arc.control_policy": { "allowControl": true },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn config_rejects_missing_config_id() {
    let result = run_config(json!({
        "execution_id": "phase6-config-invalid",
        "attempt_id": "1",
        "inputs": {
            "arc.config_export_request": {},
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn config_share_exports_and_imports() {
    let result = run_config(json!({
        "execution_id": "phase6-config",
        "attempt_id": "1",
        "inputs": {
            "arc.config_export_request": { "configId": "cfg-1" },
        },
    }));
    assert_eq!(result["ok"], true, "phase6 config failed: {result}");
    assert_eq!(
        result["outputs"]["arc.exported_config"]["state"],
        "exported"
    );
}

#[test]
fn config_import_is_independent_from_export() {
    let result = run_config_import(json!({
        "execution_id": "phase6-config-import",
        "attempt_id": "1",
        "inputs": {
            "arc.config_import_request": { "configId": "cfg-1" },
        },
    }));
    assert_eq!(result["ok"], true, "phase6 config import failed: {result}");
    assert_eq!(result["outputs"]["arc.import_result"]["state"], "imported");
}
