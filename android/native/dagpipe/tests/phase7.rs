use serde_json::{json, Value};

fn run_release(input: Value) -> Value {
    zterm_dagpipe::phase7_core::run_phase7_release_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_update(input: Value) -> Value {
    zterm_dagpipe::phase7_core::run_phase7_update_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_debug(input: Value) -> Value {
    zterm_dagpipe::phase7_core::run_phase7_debug_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

#[test]
fn compiles_phase7_graphs() {
    let graphs = zterm_dagpipe::phase7_core::compile_phase7_graphs().unwrap();
    assert_eq!(
        graphs,
        vec![
            "release.runtime_promotion@0.1",
            "release.update_lifecycle@0.1",
            "observability.debug@0.1",
        ]
    );
}

#[test]
fn release_promotes_verified_daemon_runtime() {
    let result = run_release(json!({
        "execution_id": "phase7-release",
        "attempt_id": "1",
        "inputs": {
            "arc.build_artifact": { "name": "zterm-daemon", "sha256": "abc123" },
            "arc.release_policy": { "expectedSha256": "abc123" },
        },
    }));
    assert_eq!(result["ok"], true, "phase7 release failed: {result}");
    assert_eq!(result["outputs"]["arc.runtime_started"]["state"], "started");
}

#[test]
fn update_downloads_and_installs_verified_client_update() {
    let result = run_update(json!({
        "execution_id": "phase7-update",
        "attempt_id": "1",
        "inputs": {
            "arc.update_check": { "version": "0.1.4", "sha256": "def456" },
            "arc.update_policy": { "allowUpdate": true },
        },
    }));
    assert_eq!(result["ok"], true, "phase7 update failed: {result}");
    assert_eq!(
        result["outputs"]["arc.client_update_installed"]["state"],
        "installed"
    );
}

#[test]
fn debug_samples_exports_and_cleans_bounded_store() {
    let result = run_debug(json!({
        "execution_id": "phase7-debug",
        "attempt_id": "1",
        "inputs": {
            "arc.debug_sample_request": { "sample": "trace-1" },
            "arc.debug_policy": { "allowDebug": true },
        },
    }));
    assert_eq!(result["ok"], true, "phase7 debug failed: {result}");
    assert_eq!(result["outputs"]["arc.debug_export"]["state"], "exported");
    assert_eq!(result["outputs"]["arc.debug_cleanup"]["state"], "cleaned");
}

#[test]
fn release_rejects_digest_mismatch() {
    let result = run_release(json!({
        "execution_id": "phase7-release-bad",
        "attempt_id": "1",
        "inputs": {
            "arc.build_artifact": { "name": "zterm-daemon", "sha256": "abc123" },
            "arc.release_policy": { "expectedSha256": "badhash" },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn release_rejects_missing_expected_digest() {
    let result = run_release(json!({
        "execution_id": "phase7-release-missing-expected",
        "attempt_id": "1",
        "inputs": {
            "arc.build_artifact": { "name": "zterm-daemon", "sha256": "abc123" },
            "arc.release_policy": {},
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn release_rejects_missing_artifact_digest() {
    let result = run_release(json!({
        "execution_id": "phase7-release-missing-artifact-digest",
        "attempt_id": "1",
        "inputs": {
            "arc.build_artifact": { "name": "zterm-daemon" },
            "arc.release_policy": { "expectedSha256": "abc123" },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn update_rejects_when_update_disallowed() {
    let result = run_update(json!({
        "execution_id": "phase7-update-denied",
        "attempt_id": "1",
        "inputs": {
            "arc.update_check": { "version": "0.1.4", "sha256": "def456" },
            "arc.update_policy": { "allowUpdate": false },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn update_rejects_missing_version() {
    let result = run_update(json!({
        "execution_id": "phase7-update-missing-version",
        "attempt_id": "1",
        "inputs": {
            "arc.update_check": { "sha256": "def456" },
            "arc.update_policy": { "allowUpdate": true },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn debug_rejects_unauthorized_sample() {
    let result = run_debug(json!({
        "execution_id": "phase7-debug-denied",
        "attempt_id": "1",
        "inputs": {
            "arc.debug_sample_request": { "sample": "trace-denied" },
            "arc.debug_policy": { "allowDebug": false },
        },
    }));
    assert_eq!(result["ok"], false);
}
