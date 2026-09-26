#[test]
fn phase2_runtime_graphs_are_deferred_on_static_branch() {
    assert!(zterm_dagpipe::phase2_core::compile_phase2_graphs()
        .unwrap()
        .is_empty());

    let relay = zterm_dagpipe::phase2_core::run_phase2_relay_json("{}".into()).unwrap();
    assert_eq!(relay["ok"], false);
    assert!(relay["error"].as_str().unwrap_or("").contains("deferred"));

    let daemon =
        zterm_dagpipe::phase2_core::run_phase2_daemon_connection_json("{}".into()).unwrap();
    assert_eq!(daemon["ok"], false);
    assert!(daemon["error"].as_str().unwrap_or("").contains("deferred"));
}
