pub mod core;
pub mod daemon_core;
pub mod phase2_core;

#[cfg(feature = "napi")]
use napi_derive::napi;

#[cfg(feature = "android-jni")]
mod android_jni;

#[cfg(feature = "napi")]
fn json_to_string(result: serde_json::Result<serde_json::Value>) -> String {
    match result {
        Ok(value) => serde_json::to_string(&value)
            .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.into()),
        Err(error) => serde_json::to_string(&serde_json::json!({
            "ok": false,
            "error": error.to_string(),
        }))
        .unwrap_or_default(),
    }
}

#[cfg(feature = "napi")]
fn compile_all_phase0_graphs() -> Result<Vec<String>, String> {
    let mut graphs = core::compile_phase0_graphs().map_err(|error| error.message)?;
    daemon_core::compile_phase0_graphs()?;
    graphs.extend([
        "daemon.mirror_publish@0.2".to_string(),
        "daemon.control_dispatch@0.1".to_string(),
    ]);
    Ok(graphs)
}

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase0() -> String {
    match compile_all_phase0_graphs() {
        Ok(graphs) => serde_json::to_string(&serde_json::json!({
            "ok": true,
            "graphs": graphs,
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.into()),
        Err(error) => serde_json::to_string(&serde_json::json!({
            "ok": false,
            "error": error,
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.into()),
    }
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_mirror_publish(input_json: String) -> String {
    json_to_string(daemon_core::run_mirror_publish_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_control_dispatch(input_json: String) -> String {
    json_to_string(daemon_core::run_control_dispatch_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_connection_lifecycle(input_json: String) -> String {
    json_to_string(core::run_connection_lifecycle_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_buffer_management(input_json: String) -> String {
    json_to_string(core::run_buffer_management_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_buffer_render(input_json: String) -> String {
    json_to_string(core::run_buffer_render_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_input_dispatch(input_json: String) -> String {
    json_to_string(core::run_input_dispatch_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase2() -> String {
    match phase2_core::compile_phase2_graphs() {
        Ok(graphs) => json_to_string(Ok(serde_json::json!({
            "ok": true,
            "graphs": graphs,
        }))),
        Err(error) => serde_json::to_string(&serde_json::json!({
            "ok": false,
            "error": error.message,
        }))
        .unwrap_or_default(),
    }
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase2_relay(input_json: String) -> String {
    json_to_string(phase2_core::run_phase2_relay_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase2_daemon_connection(input_json: String) -> String {
    json_to_string(phase2_core::run_phase2_daemon_connection_json(input_json))
}
