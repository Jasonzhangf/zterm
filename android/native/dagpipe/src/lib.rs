pub mod core;

#[cfg(feature = "android-jni")]
mod android_jni;

#[cfg(feature = "napi")]
use napi_derive::napi;

#[cfg(feature = "napi")]
#[napi]
pub fn compile_phase0() -> String {
    match core::compile_phase0_graphs() {
        Ok(graphs) => serde_json::to_string(&serde_json::json!({
            "ok": true,
            "graphs": graphs,
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.into()),
        Err(error) => serde_json::to_string(&serde_json::json!({
            "ok": false,
            "error": error.message,
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.into()),
    }
}

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
