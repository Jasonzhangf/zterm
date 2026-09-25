pub mod core;

#[cfg(feature = "napi")]
use napi_derive::napi;

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
pub fn compile_phase0() -> String {
    match core::compile_phase0_graphs() {
        Ok(_) => serde_json::to_string(&serde_json::json!({
            "ok": true,
            "graphs": [
                "daemon.mirror_publish@0.2",
                "daemon.control_dispatch@0.1"
            ]
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"compile response encode failed"}"#.into()),
        Err(error) => serde_json::to_string(&serde_json::json!({
            "ok": false,
            "error": error,
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"compile response encode failed"}"#.into()),
    }
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_mirror_publish(input_json: String) -> String {
    json_to_string(core::run_mirror_publish_json(input_json))
}

#[cfg(feature = "napi")]
#[napi]
pub fn run_control_dispatch(input_json: String) -> String {
    json_to_string(core::run_control_dispatch_json(input_json))
}
