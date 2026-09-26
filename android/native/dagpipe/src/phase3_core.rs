//! DAGpipe Phase 3 operators for daemon input/schedule, file transfer,
//! attachment delivery, and remote screenshot runtime projections.
//!
//! These operators consume ARC values only. They intentionally do not own
//! transport, session, buffer, or UI truth.

use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

const INPUT_SCHEDULE_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-input-schedule.graph.json");
const FILE_BROWSE_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-file-transfer-browse.graph.json");
const UPLOAD_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-file-transfer-upload.graph.json");
const DOWNLOAD_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-file-transfer-download.graph.json");
const ATTACHMENT_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-attachment-delivery.graph.json");
const SCREENSHOT_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/terminal-remote-screenshot.graph.json");

const FILE_TRANSFER_THROUGHPUT_CONTRACT_JSON: &str =
    include_str!("../../../contracts/file-transfer-throughput.json");

fn file_transfer_threshold(key: &str) -> u64 {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT
        .get_or_init(|| {
            serde_json::from_str(FILE_TRANSFER_THROUGHPUT_CONTRACT_JSON).unwrap_or(Value::Null)
        })
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn file_transfer_upload_window_chunks() -> u64 {
    file_transfer_threshold("upload_window_chunks")
}

fn file_transfer_native_write_batch_chunks() -> u64 {
    file_transfer_threshold("native_write_batch_chunks")
}

pub const INPUT_SCHEDULE_GRAPH_ID: &str = "daemon.input_schedule";
pub const FILE_BROWSE_GRAPH_ID: &str = "daemon.file_transfer_browse";
pub const UPLOAD_GRAPH_ID: &str = "daemon.file_transfer_upload";
pub const DOWNLOAD_GRAPH_ID: &str = "daemon.file_transfer_download";
pub const ATTACHMENT_GRAPH_ID: &str = "daemon.attachment_delivery";
pub const SCREENSHOT_GRAPH_ID: &str = "terminal.remote_screenshot";
pub const PHASE3_GRAPH_VERSION: &str = "0.1";

fn obj(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn inputs(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        other => vec![other],
    }
}

fn get_str<'a>(object: &'a Map<String, Value>, key: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or("")
}

fn get_bool(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn get_u64(object: &Map<String, Value>, key: &str) -> u64 {
    object.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn json_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn is_valid_attachment_id(value: &str) -> bool {
    let trimmed = value.trim();
    let hex_part = trimmed.strip_prefix("att_");
    let Some(hex_part) = hex_part else {
        return false;
    };
    let groups: Vec<&str> = hex_part.split('-').collect();
    let expected_lengths = [8usize, 4, 4, 4, 12];
    if groups.len() != expected_lengths.len() {
        return false;
    }
    groups.iter().enumerate().all(|(index, group)| {
        group.len() == expected_lengths[index] && group.chars().all(|c| c.is_ascii_hexdigit())
    })
}

fn make_registry() -> Registry {
    let mut registry = Registry::default();
    macro_rules! register {
        ($op:expr) => {
            registry.register($op).expect("register operator")
        };
    }
    register!(DaemonInputQueueEnqueue);
    register!(DaemonInputQueueAck);
    register!(TerminalDaemonInputWrite);
    register!(TerminalSchedulePlan);
    register!(TerminalScheduleFire);
    register!(DaemonInputQueueDispatchSchedule);
    register!(FileTransferValidateBrowse);
    register!(FileTransferList);
    register!(FileBrowserProject);
    register!(FileTransferValidateUpload);
    register!(FileTransferUploadSegment);
    register!(FileTransferUploadAck);
    register!(FileTransferValidateDownload);
    register!(FileTransferDownloadSegment);
    register!(FileTransferDownloadAck);
    register!(AttachmentValidate);
    register!(AttachmentEnqueue);
    register!(AttachmentDispatch);
    register!(AttachmentPublishReceipt);
    register!(RemoteScreenshotValidate);
    register!(RemoteScreenshotCapture);
    register!(RemoteScreenshotStore);
    crate::sese_core::register_sese_operators(&mut registry);
    registry
}

fn run_graph(
    request: Value,
    graph_json: &str,
    graph_id: &str,
    graph_version: &str,
) -> serde_json::Result<Value> {
    let request_obj = match request {
        Value::Object(map) => map,
        other => obj(other),
    };
    let execution_id = get_str(&request_obj, "execution_id").to_string();
    let attempt_id = get_str(&request_obj, "attempt_id").to_string();
    let mut inputs_map = request_obj
        .get("inputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<HashMap<String, Value>>();
    if let Ok(graph_value) = serde_json::from_str::<Value>(graph_json) {
        crate::sese_core::wrap_request_inputs(&graph_value, &mut inputs_map);
    }
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    let compiled = match parse_graph_json(graph_json)
        .and_then(|graph| compile(graph, &registry, &capabilities))
    {
        Ok(compiled) => compiled,
        Err(error) => {
            return Ok(json!({ "ok": false, "error": error.message }));
        }
    };
    let identity = Identity {
        project_id: "zterm".into(),
        graph_id: graph_id.into(),
        graph_version: graph_version.into(),
        execution_id: if execution_id.is_empty() {
            "execution".into()
        } else {
            execution_id
        },
        attempt_id: if attempt_id.is_empty() {
            "attempt".into()
        } else {
            attempt_id
        },
    };
    let runtime = Runtime::new(capabilities);
    match runtime.run(&compiled, identity, inputs_map, &Cancellation::default()) {
        Ok(result) => {
            let mut outputs = serde_json::Map::new();
            for (arc_id, arc) in crate::sese_core::unwrap_result_outputs(&result.outputs) {
                outputs.insert(arc_id, arc.payload.clone());
            }
            Ok(json!({ "ok": true, "outputs": Value::Object(outputs) }))
        }
        Err(failure) => Ok(json!({
            "ok": false,
            "error": failure.error.message,
        })),
    }
}

pub fn compile_phase3_graphs() -> Result<Vec<String>, CompileError> {
    let registry = make_registry();
    let capabilities = BTreeSet::new();
    for graph_json in [
        INPUT_SCHEDULE_GRAPH_JSON,
        FILE_BROWSE_GRAPH_JSON,
        UPLOAD_GRAPH_JSON,
        DOWNLOAD_GRAPH_JSON,
        ATTACHMENT_GRAPH_JSON,
        SCREENSHOT_GRAPH_JSON,
    ] {
        compile(parse_graph_json(graph_json)?, &registry, &capabilities)?;
    }
    Ok(vec![
        format!("{INPUT_SCHEDULE_GRAPH_ID}@{PHASE3_GRAPH_VERSION}"),
        format!("{FILE_BROWSE_GRAPH_ID}@{PHASE3_GRAPH_VERSION}"),
        format!("{UPLOAD_GRAPH_ID}@{PHASE3_GRAPH_VERSION}"),
        format!("{DOWNLOAD_GRAPH_ID}@{PHASE3_GRAPH_VERSION}"),
        format!("{ATTACHMENT_GRAPH_ID}@{PHASE3_GRAPH_VERSION}"),
        format!("{SCREENSHOT_GRAPH_ID}@{PHASE3_GRAPH_VERSION}"),
    ])
}

pub fn run_phase3_input_schedule_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        INPUT_SCHEDULE_GRAPH_JSON,
        INPUT_SCHEDULE_GRAPH_ID,
        PHASE3_GRAPH_VERSION,
    )
}

pub fn run_phase3_file_browse_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        FILE_BROWSE_GRAPH_JSON,
        FILE_BROWSE_GRAPH_ID,
        PHASE3_GRAPH_VERSION,
    )
}

pub fn run_phase3_upload_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        UPLOAD_GRAPH_JSON,
        UPLOAD_GRAPH_ID,
        PHASE3_GRAPH_VERSION,
    )
}

pub fn run_phase3_download_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        DOWNLOAD_GRAPH_JSON,
        DOWNLOAD_GRAPH_ID,
        PHASE3_GRAPH_VERSION,
    )
}

pub fn run_phase3_attachment_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        ATTACHMENT_GRAPH_JSON,
        ATTACHMENT_GRAPH_ID,
        PHASE3_GRAPH_VERSION,
    )
}

pub fn run_phase3_screenshot_json(input_json: String) -> serde_json::Result<Value> {
    run_graph(
        serde_json::from_str(&input_json)?,
        SCREENSHOT_GRAPH_JSON,
        SCREENSHOT_GRAPH_ID,
        PHASE3_GRAPH_VERSION,
    )
}

struct DaemonInputQueueEnqueue;

impl Operator for DaemonInputQueueEnqueue {
    fn name(&self) -> &'static str {
        "daemon.input_queue.enqueue"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let event = obj(values.first().cloned().unwrap_or_default());
        let channel_id = get_str(&event, "channelId").to_string();
        let text = get_str(&event, "text").to_string();
        if channel_id.is_empty() || text.is_empty() {
            return Err("channel input requires channelId and text".into());
        }
        Ok(json!({
            "channelId": channel_id,
            "queueId": format!("q-{}", get_str(&event, "inputId")),
            "text": text,
            "state": "enqueued",
        }))
    }
}

struct DaemonInputQueueAck;

impl Operator for DaemonInputQueueAck {
    fn name(&self) -> &'static str {
        "daemon.input_queue.ack"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let item = obj(inputs(input).first().cloned().unwrap_or_default());
        if get_str(&item, "state") != "enqueued" {
            return Err("input item must be enqueued before ack".into());
        }
        Ok(json!({
            "channelId": get_str(&item, "channelId"),
            "queueId": get_str(&item, "queueId"),
            "state": "acknowledged",
        }))
    }
}

struct TerminalDaemonInputWrite;

impl Operator for TerminalDaemonInputWrite {
    fn name(&self) -> &'static str {
        "terminal.daemon_input.write"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let ack = obj(inputs(input).first().cloned().unwrap_or_default());
        if get_str(&ack, "state") != "acknowledged" {
            return Err("input write requires acknowledged item".into());
        }
        Ok(json!({
            "channelId": get_str(&ack, "channelId"),
            "written": true,
            "state": "written",
        }))
    }
}

struct TerminalSchedulePlan;

impl Operator for TerminalSchedulePlan {
    fn name(&self) -> &'static str {
        "terminal.schedule.plan"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let policy = obj(values.first().cloned().unwrap_or_default());
        let source = obj(values.get(1).cloned().unwrap_or_default());
        let enabled = get_bool(&policy, "enabled");
        let mut jobs = json_array(source.get("jobs"));
        if !enabled {
            jobs = Vec::new();
        }
        Ok(json!({
            "jobs": jobs,
            "state": "planned",
        }))
    }
}

struct TerminalScheduleFire;

impl Operator for TerminalScheduleFire {
    fn name(&self) -> &'static str {
        "terminal.schedule.fire"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let plan = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "fired": plan.get("jobs").cloned().unwrap_or_else(|| json!([])),
            "state": "fired",
        }))
    }
}

struct DaemonInputQueueDispatchSchedule;

impl Operator for DaemonInputQueueDispatchSchedule {
    fn name(&self) -> &'static str {
        "daemon.input_queue.dispatch_schedule"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let fire = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "dispatched": fire.get("fired").cloned().unwrap_or_else(|| json!([])),
            "state": "dispatched",
        }))
    }
}

struct FileTransferValidateBrowse;

impl Operator for FileTransferValidateBrowse {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.validate_browse"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let request = obj(values.first().cloned().unwrap_or_default());
        let permission = obj(values.get(1).cloned().unwrap_or_default());
        let path = get_str(&request, "path").to_string();
        if path.is_empty() {
            return Err("file browse request requires path".into());
        }
        if !get_bool(&permission, "allowRead") {
            return Err("file browse denied by permission policy".into());
        }
        Ok(json!({
            "cwd": path,
            "entries": request.get("entries").cloned().unwrap_or_else(|| json!([])),
            "state": "validated",
        }))
    }
}

struct FileTransferList;

impl Operator for FileTransferList {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.list"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validation = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "cwd": get_str(&validation, "cwd"),
            "entries": validation.get("entries").cloned().unwrap_or_else(|| json!([])),
            "state": "listed",
        }))
    }
}

struct FileBrowserProject;

impl Operator for FileBrowserProject {
    fn name(&self) -> &'static str {
        "client.file_browser.project"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let listing = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "view": {
                "cwd": get_str(&listing, "cwd"),
                "entries": listing.get("entries").cloned().unwrap_or_else(|| json!([])),
            },
            "state": "ready",
        }))
    }
}

struct FileTransferValidateUpload;

impl Operator for FileTransferValidateUpload {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.validate_upload"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let intent = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let upload_id = get_str(&intent, "uploadId").to_string();
        if upload_id.is_empty() {
            return Err("upload intent requires uploadId".into());
        }
        if !get_bool(&policy, "allowUpload") {
            return Err("upload denied by transfer policy".into());
        }
        Ok(json!({
            "uploadId": upload_id,
            "segmentIndex": intent.get("segmentIndex").cloned().unwrap_or_else(|| json!(0)),
            "data": intent.get("data").cloned().unwrap_or_else(|| json!("")),
            "state": "validated",
        }))
    }
}

struct FileTransferUploadSegment;

impl Operator for FileTransferUploadSegment {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.upload_segment"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validation = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "uploadId": get_str(&validation, "uploadId"),
            "segmentIndex": validation.get("segmentIndex").cloned().unwrap_or_else(|| json!(0)),
            "acked": true,
            "state": "acked",
        }))
    }
}

struct FileTransferUploadAck;

impl Operator for FileTransferUploadAck {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.upload_ack"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let ack = obj(inputs(input).first().cloned().unwrap_or_default());
        if !get_bool(&ack, "acked") {
            return Err("upload segment was not acked".into());
        }
        let segment_index = get_u64(&ack, "segmentIndex");
        let complete = segment_index.saturating_add(1) >= file_transfer_upload_window_chunks();
        Ok(json!({
            "uploadId": get_str(&ack, "uploadId"),
            "segmentIndex": segment_index,
            "complete": complete,
            "state": if complete { "complete" } else { "in-progress" },
        }))
    }
}

struct FileTransferValidateDownload;

impl Operator for FileTransferValidateDownload {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.validate_download"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let intent = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let download_id = get_str(&intent, "downloadId").to_string();
        let path = get_str(&intent, "path").to_string();
        if download_id.is_empty() || path.is_empty() {
            return Err("download intent requires downloadId and path".into());
        }
        if !get_bool(&policy, "allowDownload") {
            return Err("download denied by transfer policy".into());
        }
        Ok(json!({
            "downloadId": download_id,
            "path": path,
            "chunk": intent.get("chunk").cloned().unwrap_or_else(|| json!("")),
            "segmentIndex": intent.get("segmentIndex").cloned().unwrap_or_else(|| json!(0)),
            "state": "validated",
        }))
    }
}

struct FileTransferDownloadSegment;

impl Operator for FileTransferDownloadSegment {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.download_segment"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validation = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "downloadId": get_str(&validation, "downloadId"),
            "path": get_str(&validation, "path"),
            "chunk": validation.get("chunk").cloned().unwrap_or_else(|| json!("")),
            "segmentIndex": validation.get("segmentIndex").cloned().unwrap_or_else(|| json!(0)),
            "state": "chunked",
        }))
    }
}

struct FileTransferDownloadAck;

impl Operator for FileTransferDownloadAck {
    fn name(&self) -> &'static str {
        "daemon.file_transfer.download_ack"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let chunk = obj(inputs(input).first().cloned().unwrap_or_default());
        let segment_index = get_u64(&chunk, "segmentIndex");
        let complete = segment_index.saturating_add(1) >= file_transfer_native_write_batch_chunks();
        Ok(json!({
            "downloadId": get_str(&chunk, "downloadId"),
            "segmentIndex": segment_index,
            "complete": complete,
            "state": if complete { "complete" } else { "in-progress" },
        }))
    }
}

struct AttachmentValidate;

impl Operator for AttachmentValidate {
    fn name(&self) -> &'static str {
        "daemon.attachment_delivery.validate"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let request = obj(values.first().cloned().unwrap_or_default());
        let policy = obj(values.get(1).cloned().unwrap_or_default());
        let attachment_id = get_str(&request, "attachmentId").to_string();
        let target_device_id = get_str(&request, "targetDeviceId").to_string();
        if attachment_id.is_empty() || target_device_id.is_empty() {
            return Err("attachment request requires attachmentId and targetDeviceId".into());
        }
        if !is_valid_attachment_id(&attachment_id) {
            return Err("invalid attachment id".into());
        }
        if !get_bool(&policy, "allowDelivery") {
            return Err("attachment delivery denied by policy".into());
        }
        Ok(json!({
            "attachmentId": attachment_id.trim(),
            "targetDeviceId": target_device_id,
            "state": "validated",
        }))
    }
}

struct AttachmentEnqueue;

impl Operator for AttachmentEnqueue {
    fn name(&self) -> &'static str {
        "daemon.attachment_delivery.enqueue"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validation = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "attachmentId": get_str(&validation, "attachmentId"),
            "targetDeviceId": get_str(&validation, "targetDeviceId"),
            "enqueued": true,
            "state": "enqueued",
        }))
    }
}

struct AttachmentDispatch;

impl Operator for AttachmentDispatch {
    fn name(&self) -> &'static str {
        "daemon.attachment_delivery.dispatch"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let enqueued = obj(inputs(input).first().cloned().unwrap_or_default());
        if !get_bool(&enqueued, "enqueued") {
            return Err("attachment must be enqueued before dispatch".into());
        }
        Ok(json!({
            "attachmentId": get_str(&enqueued, "attachmentId"),
            "targetDeviceId": get_str(&enqueued, "targetDeviceId"),
            "receiptId": format!("receipt-{}", get_str(&enqueued, "attachmentId")),
            "delivered": true,
            "state": "delivered",
        }))
    }
}

struct AttachmentPublishReceipt;

impl Operator for AttachmentPublishReceipt {
    fn name(&self) -> &'static str {
        "daemon.attachment_delivery.publish_receipt"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let receipt = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "attachmentId": get_str(&receipt, "attachmentId"),
            "receipt": receipt,
            "state": "published",
        }))
    }
}

struct RemoteScreenshotValidate;

impl Operator for RemoteScreenshotValidate {
    fn name(&self) -> &'static str {
        "terminal.remote_screenshot.validate"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let values = inputs(input);
        let request = obj(values.first().cloned().unwrap_or_default());
        let permission = obj(values.get(1).cloned().unwrap_or_default());
        let session_id = get_str(&request, "sessionId").to_string();
        if session_id.is_empty() {
            return Err("screenshot request requires sessionId".into());
        }
        if !get_bool(&permission, "allowScreenshot") {
            return Err("screenshot denied by permission policy".into());
        }
        Ok(json!({
            "sessionId": session_id,
            "bytes": request.get("bytes").cloned().unwrap_or_else(|| json!("")),
            "state": "validated",
        }))
    }
}

struct RemoteScreenshotCapture;

impl Operator for RemoteScreenshotCapture {
    fn name(&self) -> &'static str {
        "terminal.remote_screenshot.capture"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let validation = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&validation, "sessionId"),
            "bytes": validation.get("bytes").cloned().unwrap_or_else(|| json!("")),
            "state": "captured",
        }))
    }
}

struct RemoteScreenshotStore;

impl Operator for RemoteScreenshotStore {
    fn name(&self) -> &'static str {
        "terminal.remote_screenshot.store"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let captured = obj(inputs(input).first().cloned().unwrap_or_default());
        Ok(json!({
            "sessionId": get_str(&captured, "sessionId"),
            "bytes": captured.get("bytes").cloned().unwrap_or_else(|| json!("")),
            "state": "ready",
        }))
    }
}
