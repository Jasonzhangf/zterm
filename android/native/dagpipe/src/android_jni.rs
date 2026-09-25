use jni::objects::{JClass, JObject, JString};
use jni::sys::jstring;
use jni::JNIEnv;

fn read_string(env: &mut JNIEnv, input: jstring) -> String {
    let object = unsafe { JObject::from_raw(input) };
    env.get_string(&JString::from(object))
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn string_result(result: Result<String, serde_json::Error>) -> String {
    match result {
        Ok(value) => value,
        Err(error) => format!(
            "{{\"ok\":false,\"error\":{}}}",
            serde_json::to_string(&error.to_string()).unwrap_or_else(|_| "encode_error".into())
        ),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_compilePhase0(
    env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = match crate::core::compile_phase0_graphs() {
        Ok(graphs) => serde_json::to_string(&serde_json::json!({
            "ok": true,
            "graphs": graphs,
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.into()),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": error.message,
        })
        .to_string(),
    };
    env.new_string(result)
        .expect("jni new_string compile_phase0")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_compileAllDagpipePhases(
    env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = match crate::compile_all_dagpipe_phases_result() {
        Ok(graphs) => serde_json::to_string(&serde_json::json!({
            "ok": true,
            "graphs": graphs,
        }))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"json encode failed"}"#.into()),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": error,
        })
        .to_string(),
    };
    env.new_string(result)
        .expect("jni new_string compile_all_dagpipe_phases")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runPhase8Connection(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result = string_result(
        crate::phase8_core::run_phase8_connection_json(input).map(|value| value.to_string()),
    );
    env.new_string(result)
        .expect("jni new_string run_phase8_connection")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runPhase6Control(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result = string_result(
        crate::phase6_core::run_phase6_control_json(input).map(|value| value.to_string()),
    );
    env.new_string(result)
        .expect("jni new_string run_phase6_control")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runPhase7Update(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result = string_result(
        crate::phase7_core::run_phase7_update_json(input).map(|value| value.to_string()),
    );
    env.new_string(result)
        .expect("jni new_string run_phase7_update")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runPhase4RemoteWindow(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result = string_result(
        crate::phase4_core::run_phase4_remote_window_json(input).map(|value| value.to_string()),
    );
    env.new_string(result)
        .expect("jni new_string run_phase4_remote_window")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runConnectionLifecycle(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result = string_result(
        crate::core::run_connection_lifecycle_json(input).map(|value| value.to_string()),
    );
    env.new_string(result)
        .expect("jni new_string run_connection_lifecycle")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runBufferManagement(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result = string_result(
        crate::core::run_buffer_management_json(input).map(|value| value.to_string()),
    );
    env.new_string(result)
        .expect("jni new_string run_buffer_management")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runBufferRender(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result =
        string_result(crate::core::run_buffer_render_json(input).map(|value| value.to_string()));
    env.new_string(result)
        .expect("jni new_string run_buffer_render")
        .into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_zterm_android_DagpipeCoreBridge_runInputDispatch(
    mut env: JNIEnv,
    _class: JClass,
    input_json: jstring,
) -> jstring {
    let input = read_string(&mut env, input_json);
    let result =
        string_result(crate::core::run_input_dispatch_json(input).map(|value| value.to_string()));
    env.new_string(result)
        .expect("jni new_string run_input_dispatch")
        .into_raw()
}
