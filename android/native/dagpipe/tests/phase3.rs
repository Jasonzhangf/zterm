use serde_json::{json, Value};

fn run_input_schedule(input: Value) -> Value {
    zterm_dagpipe::phase3_core::run_phase3_input_schedule_json(
        serde_json::to_string(&input).unwrap(),
    )
    .unwrap()
}

fn run_file_browse(input: Value) -> Value {
    zterm_dagpipe::phase3_core::run_phase3_file_browse_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_upload(input: Value) -> Value {
    zterm_dagpipe::phase3_core::run_phase3_upload_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_download(input: Value) -> Value {
    zterm_dagpipe::phase3_core::run_phase3_download_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_attachment(input: Value) -> Value {
    zterm_dagpipe::phase3_core::run_phase3_attachment_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

fn run_screenshot(input: Value) -> Value {
    zterm_dagpipe::phase3_core::run_phase3_screenshot_json(serde_json::to_string(&input).unwrap())
        .unwrap()
}

#[test]
fn compiles_phase3_graphs() {
    let graphs = zterm_dagpipe::phase3_core::compile_phase3_graphs().unwrap();
    assert_eq!(
        graphs,
        vec![
            "daemon.input_schedule@0.1",
            "daemon.file_transfer_browse@0.1",
            "daemon.file_transfer_upload@0.1",
            "daemon.file_transfer_download@0.1",
            "daemon.attachment_delivery@0.1",
            "terminal.remote_screenshot@0.1",
        ]
    );
}

#[test]
fn input_schedule_keeps_input_and_timer_chains_decoupled() {
    let result = run_input_schedule(json!({
        "execution_id": "phase3-input-schedule",
        "attempt_id": "1",
        "inputs": {
            "arc.channel_input_event": { "channelId": "chan-1", "inputId": "i-1", "text": "ls\r" },
            "arc.input_policy": { "maxInFlight": 8 },
            "arc.schedule_policy": { "enabled": true },
            "arc.schedule_source": { "jobs": [{ "jobId": "j-1", "command": "session-list" }] },
        },
    }));
    assert_eq!(result["ok"], true);
    let outputs = &result["outputs"];
    assert_eq!(outputs["arc.backend_write_result"]["state"], "written");
    assert_eq!(outputs["arc.input_ack"]["state"], "acknowledged");
    assert_eq!(outputs["arc.schedule_dispatch"]["state"], "dispatched");
    assert_eq!(
        outputs["arc.schedule_dispatch"]["dispatched"][0]["jobId"],
        "j-1"
    );
}

#[test]
fn input_schedule_rejects_invalid_channel_input() {
    let result = run_input_schedule(json!({
        "execution_id": "phase3-invalid-input",
        "attempt_id": "1",
        "inputs": {
            "arc.channel_input_event": { "channelId": "chan-1" },
            "arc.input_policy": {},
            "arc.schedule_policy": {},
            "arc.schedule_source": {},
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn file_browse_validates_and_projects_daemon_listing() {
    let result = run_file_browse(json!({
        "execution_id": "phase3-browse",
        "attempt_id": "1",
        "inputs": {
            "arc.file_browse_request": {
                "path": "/tmp",
                "entries": [{ "name": "a.txt", "kind": "file" }],
            },
            "arc.fs_permission_policy": { "allowRead": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.file_browser_view"]["view"]["cwd"],
        "/tmp"
    );
    assert_eq!(
        result["outputs"]["arc.file_browser_view"]["view"]["entries"][0]["name"],
        "a.txt"
    );
}

#[test]
fn file_browse_denied_when_permission_missing() {
    let result = run_file_browse(json!({
        "execution_id": "phase3-browse-deny",
        "attempt_id": "1",
        "inputs": {
            "arc.file_browse_request": { "path": "/tmp" },
            "arc.fs_permission_policy": { "allowRead": false },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn upload_segment_ack_completes_transfer() {
    let result = run_upload(json!({
        "execution_id": "phase3-upload",
        "attempt_id": "1",
        "inputs": {
            "arc.upload_intent": { "uploadId": "up-1", "segmentIndex": 0, "totalChunks": 1, "data": "abc" },
            "arc.transfer_policy": { "allowUpload": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.upload_complete"]["complete"], true);
}

#[test]
fn download_segment_ack_completes_transfer() {
    let result = run_download(json!({
        "execution_id": "phase3-download",
        "attempt_id": "1",
        "inputs": {
            "arc.download_intent": { "downloadId": "dl-1", "path": "/tmp/a.txt", "chunk": "abc", "segmentIndex": 0, "totalChunks": 1 },
            "arc.transfer_policy": { "allowDownload": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.download_complete"]["complete"], true);
}

#[test]
fn upload_ack_completes_only_on_exact_final_total_chunks() {
    let result = run_upload(json!({
        "execution_id": "phase3-upload-multi-window",
        "attempt_id": "1",
        "inputs": {
            "arc.upload_intent": { "uploadId": "up-mw", "segmentIndex": 11, "totalChunks": 12, "data": "abc" },
            "arc.transfer_policy": { "allowUpload": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.upload_complete"]["complete"], true);
}

#[test]
fn upload_ack_stays_in_progress_before_exact_total_chunks() {
    let result = run_upload(json!({
        "execution_id": "phase3-upload-in-progress",
        "attempt_id": "1",
        "inputs": {
            "arc.upload_intent": { "uploadId": "up-2", "segmentIndex": 7, "totalChunks": 12, "data": "abc" },
            "arc.transfer_policy": { "allowUpload": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.upload_complete"]["complete"], false);
    assert_eq!(
        result["outputs"]["arc.upload_complete"]["state"],
        "in-progress"
    );
}

#[test]
fn upload_rejects_segment_index_at_or_above_total_chunks() {
    for segment_index in [12, 13] {
        let result = run_upload(json!({
            "execution_id": format!("phase3-upload-overshoot-{segment_index}"),
            "attempt_id": "1",
            "inputs": {
                "arc.upload_intent": {
                    "uploadId": "up-overshoot",
                    "segmentIndex": segment_index,
                    "totalChunks": 12,
                    "data": "abc",
                },
                "arc.transfer_policy": { "allowUpload": true },
            },
        }));
        assert_eq!(result["ok"], false);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("out of range for totalChunks 12"));
    }
}

#[test]
fn upload_rejects_non_integer_or_zero_chunk_fields() {
    for intent in [
        json!({ "uploadId": "up-1", "segmentIndex": -1, "totalChunks": 1, "data": "abc" }),
        json!({ "uploadId": "up-1", "segmentIndex": 1.5, "totalChunks": 1, "data": "abc" }),
        json!({ "uploadId": "up-1", "segmentIndex": "0", "totalChunks": 1, "data": "abc" }),
        json!({ "uploadId": "up-1", "segmentIndex": 0, "totalChunks": -1, "data": "abc" }),
        json!({ "uploadId": "up-1", "segmentIndex": 0, "totalChunks": 0, "data": "abc" }),
        json!({ "uploadId": "up-1", "segmentIndex": 0, "totalChunks": "1", "data": "abc" }),
    ] {
        let result = run_upload(json!({
            "execution_id": "phase3-upload-invalid-chunk-shape",
            "attempt_id": "1",
            "inputs": {
                "arc.upload_intent": intent,
                "arc.transfer_policy": { "allowUpload": true },
            },
        }));
        assert_eq!(result["ok"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("must be a non-negative integer")
                || result["error"]
                    .as_str()
                    .unwrap()
                    .contains("totalChunks must be at least 1")
        );
    }
}

#[test]
fn download_ack_completes_only_on_exact_final_total_chunks() {
    let result = run_download(json!({
        "execution_id": "phase3-download-multi-batch",
        "attempt_id": "1",
        "inputs": {
            "arc.download_intent": { "downloadId": "dl-mb", "path": "/tmp/a.txt", "chunk": "abc", "segmentIndex": 15, "totalChunks": 16 },
            "arc.transfer_policy": { "allowDownload": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.download_complete"]["complete"], true);
}

#[test]
fn download_ack_stays_in_progress_before_exact_total_chunks() {
    let result = run_download(json!({
        "execution_id": "phase3-download-in-progress",
        "attempt_id": "1",
        "inputs": {
            "arc.download_intent": { "downloadId": "dl-2", "path": "/tmp/a.txt", "chunk": "abc", "segmentIndex": 7, "totalChunks": 16 },
            "arc.transfer_policy": { "allowDownload": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.download_complete"]["complete"],
        false
    );
    assert_eq!(
        result["outputs"]["arc.download_complete"]["state"],
        "in-progress"
    );
}

#[test]
fn download_rejects_segment_index_at_or_above_total_chunks() {
    for segment_index in [16, 17] {
        let result = run_download(json!({
            "execution_id": format!("phase3-download-overshoot-{segment_index}"),
            "attempt_id": "1",
            "inputs": {
                "arc.download_intent": {
                    "downloadId": "dl-overshoot",
                    "path": "/tmp/a.txt",
                    "chunk": "abc",
                    "segmentIndex": segment_index,
                    "totalChunks": 16,
                },
                "arc.transfer_policy": { "allowDownload": true },
            },
        }));
        assert_eq!(result["ok"], false);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("out of range for totalChunks 16"));
    }
}

#[test]
fn download_rejects_non_integer_or_zero_chunk_fields() {
    for intent in [
        json!({ "downloadId": "dl-1", "path": "/tmp/a.txt", "segmentIndex": -1, "totalChunks": 1, "chunk": "abc" }),
        json!({ "downloadId": "dl-1", "path": "/tmp/a.txt", "segmentIndex": 1.5, "totalChunks": 1, "chunk": "abc" }),
        json!({ "downloadId": "dl-1", "path": "/tmp/a.txt", "segmentIndex": "0", "totalChunks": 1, "chunk": "abc" }),
        json!({ "downloadId": "dl-1", "path": "/tmp/a.txt", "segmentIndex": 0, "totalChunks": -1, "chunk": "abc" }),
        json!({ "downloadId": "dl-1", "path": "/tmp/a.txt", "segmentIndex": 0, "totalChunks": 0, "chunk": "abc" }),
        json!({ "downloadId": "dl-1", "path": "/tmp/a.txt", "segmentIndex": 0, "totalChunks": "1", "chunk": "abc" }),
    ] {
        let result = run_download(json!({
            "execution_id": "phase3-download-invalid-chunk-shape",
            "attempt_id": "1",
            "inputs": {
                "arc.download_intent": intent,
                "arc.transfer_policy": { "allowDownload": true },
            },
        }));
        assert_eq!(result["ok"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("must be a non-negative integer")
                || result["error"]
                    .as_str()
                    .unwrap()
                    .contains("totalChunks must be at least 1")
        );
    }
}

#[test]
fn upload_denied_when_policy_forbids_upload() {
    let result = run_upload(json!({
        "execution_id": "phase3-upload-deny",
        "attempt_id": "1",
        "inputs": {
            "arc.upload_intent": { "uploadId": "up-1" },
            "arc.transfer_policy": { "allowUpload": false },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn download_denied_when_policy_forbids_download() {
    let result = run_download(json!({
        "execution_id": "phase3-download-deny",
        "attempt_id": "1",
        "inputs": {
            "arc.download_intent": { "downloadId": "dl-1", "path": "/tmp/a.txt" },
            "arc.transfer_policy": { "allowDownload": false },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn attachment_delivery_receipt_is_not_client_consumption() {
    let result = run_attachment(json!({
        "execution_id": "phase3-attachment",
        "attempt_id": "1",
        "inputs": {
            "arc.attachment_delivery_request": { "attachmentId": "att_12345678-1234-1234-1234-123456789abc", "targetDeviceId": "dev-1" },
            "arc.attachment_policy": { "allowDelivery": true },
        },
    }));
    assert_eq!(result["ok"], true);
    let delivery = &result["outputs"]["arc.attachment_delivery_result"];
    assert_eq!(delivery["state"], "published");
    assert_eq!(delivery["receipt"]["state"], "delivered");
}

#[test]
fn attachment_rejects_malformed_id_like_ts_validate_attachment_id() {
    let result = run_attachment(json!({
        "execution_id": "phase3-attachment-invalid-id",
        "attempt_id": "1",
        "inputs": {
            "arc.attachment_delivery_request": { "attachmentId": "att-1", "targetDeviceId": "dev-1" },
            "arc.attachment_policy": { "allowDelivery": true },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn attachment_accepts_uppercase_prefix_like_ts_validate_attachment_id() {
    let result = run_attachment(json!({
        "execution_id": "phase3-attachment-uppercase-id",
        "attempt_id": "1",
        "inputs": {
            "arc.attachment_delivery_request": { "attachmentId": "ATT_12345678-1234-1234-1234-123456789abc", "targetDeviceId": "dev-1" },
            "arc.attachment_policy": { "allowDelivery": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["outputs"]["arc.attachment_delivery_result"]["state"],
        "published"
    );
}

#[test]
fn attachment_denied_when_policy_forbids_delivery() {
    let result = run_attachment(json!({
        "execution_id": "phase3-attachment-deny",
        "attempt_id": "1",
        "inputs": {
            "arc.attachment_delivery_request": {
                "attachmentId": "att_12345678-1234-1234-1234-123456789abc",
                "targetDeviceId": "dev-1",
            },
            "arc.attachment_policy": { "allowDelivery": false },
        },
    }));
    assert_eq!(result["ok"], false);
}

#[test]
fn screenshot_capture_stores_result() {
    let result = run_screenshot(json!({
        "execution_id": "phase3-screenshot",
        "attempt_id": "1",
        "inputs": {
            "arc.screenshot_request": { "sessionId": "sess-1", "bytes": "png-bytes" },
            "arc.screenshot_permission": { "allowScreenshot": true },
        },
    }));
    assert_eq!(result["ok"], true);
    assert_eq!(result["outputs"]["arc.screenshot_result"]["state"], "ready");
    assert_eq!(
        result["outputs"]["arc.screenshot_result"]["bytes"],
        "png-bytes"
    );
}

#[test]
fn screenshot_denied_when_permission_missing() {
    let result = run_screenshot(json!({
        "execution_id": "phase3-screenshot-deny",
        "attempt_id": "1",
        "inputs": {
            "arc.screenshot_request": { "sessionId": "sess-1" },
            "arc.screenshot_permission": { "allowScreenshot": false },
        },
    }));
    assert_eq!(result["ok"], false);
}
