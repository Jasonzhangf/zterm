use serde_json::{json, Value};

fn run_shell_lifecycle(input: Value) -> Value {
    zterm_dagpipe::phase5_core::run_phase5_shell_lifecycle_json(
        serde_json::to_string(&input).unwrap(),
    )
    .unwrap()
}

fn run_preview_lattice(input: Value) -> Value {
    zterm_dagpipe::phase5_core::run_phase5_preview_lattice_json(
        serde_json::to_string(&input).unwrap(),
    )
    .unwrap()
}

#[test]
fn compiles_phase5_graphs() {
    let graphs = zterm_dagpipe::phase5_core::compile_phase5_graphs().unwrap();
    assert_eq!(
        graphs,
        vec![
            "android.session_shell_lifecycle@0.1",
            "android.session_preview_lattice@0.1",
        ]
    );
}

#[test]
fn shell_lifecycle_projects_open_tab_shell_and_controls() {
    let result = run_shell_lifecycle(json!({
        "execution_id": "phase5-shell",
        "attempt_id": "1",
        "inputs": {
            "arc.open_tab_intent": { "sessionId": "s1" },
            "arc.shell_state": { "visible": true },
        },
    }));
    assert_eq!(result["ok"], true, "phase5 shell failed: {result}");
    let outputs = &result["outputs"];
    assert_eq!(outputs["arc.shell_projection"]["state"], "projected");
    assert_eq!(outputs["arc.quickbar_projection"]["state"], "projected");
    assert_eq!(outputs["arc.copy_projection"]["state"], "projected");
    assert_eq!(outputs["arc.keyboard_lift"]["state"], "projected");
}

#[test]
fn preview_lattice_selects_or_pans_without_joining_mutually_exclusive_paths() {
    let select_only = run_preview_lattice(json!({
        "execution_id": "phase5-select",
        "attempt_id": "1",
        "inputs": {
            "arc.preview_open_intent": {
                "sessionId": "s1",
                "cells": [{ "cellId": "c1", "sessionId": "s1" }],
            },
            "arc.preview_select": { "cellId": "c1" },
            "arc.focus_pan": {},
        },
    }));
    assert_eq!(
        select_only["ok"], true,
        "phase5 select failed: {select_only}"
    );
    assert_eq!(
        select_only["outputs"]["arc.focus_selection"]["state"],
        "applied"
    );
    assert_eq!(
        select_only["outputs"]["arc.focus_panned"]["state"],
        "skipped"
    );

    let pan_only = run_preview_lattice(json!({
        "execution_id": "phase5-pan",
        "attempt_id": "1",
        "inputs": {
            "arc.preview_open_intent": {
                "sessionId": "s1",
                "cells": [{ "cellId": "c1", "sessionId": "s1" }],
            },
            "arc.preview_select": {},
            "arc.focus_pan": { "direction": "right" },
        },
    }));
    assert_eq!(pan_only["ok"], true, "phase5 pan failed: {pan_only}");
    assert_eq!(
        pan_only["outputs"]["arc.focus_selection"]["state"],
        "skipped"
    );
    assert_eq!(pan_only["outputs"]["arc.focus_panned"]["state"], "applied");
}
