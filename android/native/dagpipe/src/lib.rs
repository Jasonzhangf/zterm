pub mod core;
pub mod daemon_core;
pub mod phase2_core;
pub mod phase3_core;
pub mod phase4_core;
pub mod phase5_core;
pub mod phase6_core;
pub mod phase7_core;
pub mod phase8_core;
pub mod sese_core;

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

pub fn compile_all_dagpipe_phases_result() -> Result<Vec<String>, String> {
    let mut graphs = core::compile_phase0_graphs().map_err(|error| error.message)?;
    daemon_core::compile_phase0_graphs()?;
    graphs.extend([
        "daemon.mirror_publish@0.2".to_string(),
        "daemon.control_dispatch@0.1".to_string(),
    ]);
    graphs.extend(phase2_core::compile_phase2_graphs().map_err(|error| error.message)?);
    graphs.extend(phase3_core::compile_phase3_graphs().map_err(|error| error.message)?);
    graphs.extend(phase4_core::compile_phase4_graphs().map_err(|error| error.message)?);
    graphs.extend(phase5_core::compile_phase5_graphs().map_err(|error| error.message)?);
    graphs.extend(phase6_core::compile_phase6_graphs().map_err(|error| error.message)?);
    graphs.extend(phase7_core::compile_phase7_graphs().map_err(|error| error.message)?);
    graphs.extend(phase8_core::compile_phase8_graphs().map_err(|error| error.message)?);
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
pub fn compile_all_dagpipe_phases() -> String {
    match compile_all_dagpipe_phases_result() {
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

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase3() -> String {
    match phase3_core::compile_phase3_graphs() {
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
pub fn run_phase3_input_schedule(input_json: String) -> String {
    json_to_string(phase3_core::run_phase3_input_schedule_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase3_file_browse(input_json: String) -> String {
    json_to_string(phase3_core::run_phase3_file_browse_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase3_upload(input_json: String) -> String {
    json_to_string(phase3_core::run_phase3_upload_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase3_download(input_json: String) -> String {
    json_to_string(phase3_core::run_phase3_download_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase3_attachment(input_json: String) -> String {
    json_to_string(phase3_core::run_phase3_attachment_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase3_screenshot(input_json: String) -> String {
    json_to_string(phase3_core::run_phase3_screenshot_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase4() -> String {
    match phase4_core::compile_phase4_graphs() {
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
pub fn run_phase4_remote_window(input_json: String) -> String {
    json_to_string(phase4_core::run_phase4_remote_window_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase5() -> String {
    match phase5_core::compile_phase5_graphs() {
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
pub fn run_phase5_shell_lifecycle(input_json: String) -> String {
    json_to_string(phase5_core::run_phase5_shell_lifecycle_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase5_preview_lattice(input_json: String) -> String {
    json_to_string(phase5_core::run_phase5_preview_lattice_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase6() -> String {
    match phase6_core::compile_phase6_graphs() {
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
pub fn run_phase6_composition(input_json: String) -> String {
    json_to_string(phase6_core::run_phase6_composition_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase6_control(input_json: String) -> String {
    json_to_string(phase6_core::run_phase6_control_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase6_config_export(input_json: String) -> String {
    json_to_string(phase6_core::run_phase6_config_export_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase6_config_import(input_json: String) -> String {
    json_to_string(phase6_core::run_phase6_config_import_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase7() -> String {
    match phase7_core::compile_phase7_graphs() {
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
pub fn run_phase7_release(input_json: String) -> String {
    json_to_string(phase7_core::run_phase7_release_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase7_update(input_json: String) -> String {
    json_to_string(phase7_core::run_phase7_update_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_phase7_debug(input_json: String) -> String {
    json_to_string(phase7_core::run_phase7_debug_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase8() -> String {
    match phase8_core::compile_phase8_graphs() {
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
pub fn run_phase8_connection(input_json: String) -> String {
    json_to_string(phase8_core::run_phase8_connection_json(input_json))
}
