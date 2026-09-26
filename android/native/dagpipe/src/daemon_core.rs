use pipeline_runtime::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

const MIRROR_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-mirror-publish.graph.json");
const CONTROL_GRAPH_JSON: &str =
    include_str!("../../../docs/dagpipe/daemon-control-dispatch.graph.json");

static MIRROR_COMPILED: OnceLock<Result<CompiledGraph, String>> = OnceLock::new();
static CONTROL_COMPILED: OnceLock<Result<CompiledGraph, String>> = OnceLock::new();

fn mirror_compiled() -> Result<&'static CompiledGraph, &'static str> {
    match MIRROR_COMPILED.get_or_init(|| {
        mirror_graph()
            .and_then(|graph| compile(graph, &registry(), &BTreeSet::new()))
            .map_err(|error| error.message)
    }) {
        Ok(graph) => Ok(graph),
        Err(message) => Err(message),
    }
}

fn control_compiled() -> Result<&'static CompiledGraph, &'static str> {
    match CONTROL_COMPILED.get_or_init(|| {
        control_graph()
            .and_then(|graph| compile(graph, &registry(), &BTreeSet::new()))
            .map_err(|error| error.message)
    }) {
        Ok(graph) => Ok(graph),
        Err(message) => Err(message),
    }
}

pub fn compile_phase0_graphs() -> Result<(), String> {
    mirror_compiled().map_err(String::from)?;
    control_compiled().map_err(String::from)?;
    Ok(())
}

pub fn run_mirror_publish_json(input_json: String) -> serde_json::Result<Value> {
    let request: Value = serde_json::from_str(&input_json)?;
    run_request_run(request, "daemon.mirror_publish", "0.2", "arc.wire_frames")
}

pub fn run_control_dispatch_json(input_json: String) -> serde_json::Result<Value> {
    let request: Value = serde_json::from_str(&input_json)?;
    run_request_run(
        request,
        "daemon.control_dispatch",
        "0.1",
        "arc.control_result",
    )
}

fn run_request_run(
    request: Value,
    graph_id: &str,
    graph_version: &str,
    output_arc: &str,
) -> serde_json::Result<Value> {
    let execution_id = request
        .get("execution_id")
        .and_then(Value::as_str)
        .unwrap_or("execution")
        .to_string();
    let attempt_id = request
        .get("attempt_id")
        .and_then(Value::as_str)
        .unwrap_or("attempt")
        .to_string();
    let mut inputs = request
        .get("inputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<HashMap<String, Value>>();
    let graph_json = if graph_id == "daemon.mirror_publish" {
        MIRROR_GRAPH_JSON
    } else {
        CONTROL_GRAPH_JSON
    };
    if let Ok(graph_value) = serde_json::from_str::<Value>(graph_json) {
        crate::sese_core::wrap_request_inputs(&graph_value, &mut inputs);
    }
    let compiled = if graph_id == "daemon.mirror_publish" {
        mirror_compiled()
    } else {
        control_compiled()
    };
    let compiled = match compiled {
        Ok(graph) => graph,
        Err(message) => {
            return Ok(json!({
                "ok": false,
                "error": message,
            }));
        }
    };
    let identity = Identity {
        project_id: "zterm".into(),
        graph_id: graph_id.into(),
        graph_version: graph_version.into(),
        execution_id,
        attempt_id,
    };
    let capabilities = BTreeSet::new();
    let runtime = Runtime::new(capabilities);
    match runtime.run(compiled, identity, inputs, &Cancellation::default()) {
        Ok(result) => {
            let output = crate::sese_core::unwrap_result_outputs(&result.outputs)
                .get(output_arc)
                .map(|arc| arc.payload.clone())
                .unwrap_or(Value::Null);
            Ok(json!({
                "ok": true,
                "outputs": {
                    output_arc: output,
                }
            }))
        }
        Err(failure) => Ok(json!({
            "ok": false,
            "error": failure.error.message,
            "journal": serde_json::to_value(failure.journal).unwrap_or(Value::Null),
        })),
    }
}

fn mirror_graph() -> Result<Graph, CompileError> {
    parse_graph_json(MIRROR_GRAPH_JSON)
}

fn control_graph() -> Result<Graph, CompileError> {
    parse_graph_json(CONTROL_GRAPH_JSON)
}

fn registry() -> Registry {
    let mut registry = Registry::default();
    macro_rules! register {
        ($op:expr) => {
            registry.register($op).expect("register operator")
        };
    }
    register!(SourceNormalize);
    register!(MirrorWriterCommit);
    register!(MirrorStoreApply);
    register!(MirrorStoreDiff);
    register!(MirrorStoreClassify);
    register!(BufferPublisherPlan);
    register!(BufferPublisherEmit);
    register!(ControlGatewayAuthenticate);
    register!(ControlCenterRoute);
    register!(ControlOwnerDispatch);
    crate::sese_core::register_sese_operators(&mut registry);
    registry
}

fn obj(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn take_array(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        _ => vec![value.clone()],
    }
}

fn range_to_json(range: (u64, u64)) -> Value {
    json!({ "startIndex": range.0, "endIndex": range.1 })
}

fn abs_start(value: &Value) -> u64 {
    value
        .get("bufferStartIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn abs_lines(value: &Value) -> Vec<Value> {
    value
        .get("bufferLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn abs_end(value: &Value) -> u64 {
    abs_start(value) + abs_lines(value).len() as u64
}

fn changed_ranges_for_window(prev: &Value, next: &Value, full_resync: bool) -> Vec<(u64, u64)> {
    let next_start = abs_start(next);
    let next_lines = abs_lines(next);
    let next_end = next_start + next_lines.len() as u64;
    if full_resync || next_lines.is_empty() {
        return if full_resync && !next_lines.is_empty() {
            vec![(next_start, next_end)]
        } else {
            Vec::new()
        };
    }
    let prev_start = abs_start(prev);
    let prev_lines = abs_lines(prev);
    let mut changed = Vec::new();
    let mut active: Option<u64> = None;
    for index in next_start..next_end {
        let prev_offset = if index >= prev_start {
            Some((index - prev_start) as usize)
        } else {
            None
        };
        let prev_row = prev_offset.and_then(|offset| prev_lines.get(offset));
        let next_row = next_lines.get((index - next_start) as usize);
        let equal = match (prev_row, next_row) {
            (Some(left), Some(right)) => left == right,
            _ => false,
        };
        if !equal {
            if active.is_none() {
                active = Some(index);
            }
            continue;
        }
        if let Some(start) = active.take() {
            changed.push((start, index));
        }
    }
    if let Some(start) = active.take() {
        changed.push((start, next_end));
    }
    changed
}

fn collapse_ranges(ranges: &[(u64, u64)]) -> Vec<(u64, u64)> {
    if ranges.is_empty() {
        return Vec::new();
    }
    let mut sorted: Vec<_> = ranges.to_vec();
    sorted.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::new();
    for range in sorted {
        if let Some(last) = merged.last_mut() {
            if range.0 <= last.1 {
                last.1 = last.1.max(range.1);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

struct SourceNormalize;
impl Operator for SourceNormalize {
    fn name(&self) -> &'static str {
        "daemon.source_adapter.normalize"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let mut snapshot = obj(input);
        let start = snapshot
            .get("bufferStartIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let lines = snapshot
            .get("bufferLines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        snapshot.insert("bufferStartIndex".into(), json!(start));
        snapshot.insert("bufferLines".into(), Value::Array(lines.clone()));
        Ok(Value::Object(snapshot))
    }
}

struct MirrorWriterCommit;
impl Operator for MirrorWriterCommit {
    fn name(&self) -> &'static str {
        "daemon.mirror_writer.commit"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let snapshot = obj(input);
        if snapshot.get("bufferStartIndex").is_none() || snapshot.get("bufferLines").is_none() {
            return Err("canonical snapshot requires bufferStartIndex and bufferLines".into());
        }
        let revision = snapshot
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let mut rev = snapshot.clone();
        rev.insert("revision".into(), json!(revision));
        Ok(Value::Object(rev))
    }
}

struct MirrorStoreApply;
impl Operator for MirrorStoreApply {
    fn name(&self) -> &'static str {
        "daemon.mirror_store.apply"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        Ok(input)
    }
}

struct MirrorStoreDiff;
impl Operator for MirrorStoreDiff {
    fn name(&self) -> &'static str {
        "daemon.mirror_store.diff"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let inputs = take_array(&input);
        let diff_policy = inputs.first().cloned().unwrap_or_default();
        let prev = inputs.get(1).cloned().unwrap_or_default();
        let truth = inputs.get(2).cloned().unwrap_or_default();
        let full_resync = diff_policy
            .get("fullResync")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let ranges = changed_ranges_for_window(&prev, &truth, full_resync);
        Ok(json!({ "ranges": ranges.into_iter().map(range_to_json).collect::<Vec<_>>() }))
    }
}

struct MirrorStoreClassify;
impl Operator for MirrorStoreClassify {
    fn name(&self) -> &'static str {
        "daemon.mirror_store.classify"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let inputs = take_array(&input);
        let diff_policy = inputs.first().cloned().unwrap_or_default();
        let prev = inputs.get(1).cloned().unwrap_or_default();
        let truth = inputs.get(2).cloned().unwrap_or_default();
        let changed = inputs
            .get(3)
            .and_then(|value| value.get("ranges"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut ranges: Vec<(u64, u64)> = Vec::new();
        for range in changed {
            let start = range.get("startIndex").and_then(Value::as_u64).unwrap_or(0);
            let end = range.get("endIndex").and_then(Value::as_u64).unwrap_or(0);
            ranges.push((start, end));
        }
        let forced = diff_policy
            .get("fullResync")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let prev_start = abs_start(&prev);
        let prev_len = abs_lines(&prev).len() as u64;
        let truth_start = abs_start(&truth);
        let truth_lines = abs_lines(&truth);
        let truth_len = truth_lines.len() as u64;
        let prev_end = abs_end(&prev);
        let truth_end = abs_end(&truth);
        let kind = if forced {
            "reset"
        } else if ranges.is_empty() {
            "head-only"
        } else if prev_end <= truth_start || truth_end <= prev_start || truth_start > prev_start {
            "window-shift"
        } else if truth_start == prev_start && truth_len > prev_len {
            "append"
        } else {
            "rewrite"
        };
        Ok(json!({
            "kind": kind,
            "firstStartIndex": ranges.first().map(|(s, _)| *s).unwrap_or(prev_end),
            "lastEndIndex": ranges.last().map(|(_, e)| *e).unwrap_or(prev_end),
            "revision": truth.get("revision").cloned().unwrap_or(Value::Null),
        }))
    }
}

struct BufferPublisherPlan;
impl Operator for BufferPublisherPlan {
    fn name(&self) -> &'static str {
        "daemon.buffer_publisher.plan"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let inputs = take_array(&input);
        let diff_policy = inputs.first().cloned().unwrap_or_default();
        let update = inputs.get(1).cloned().unwrap_or_default();
        let changed = inputs.get(2).cloned().unwrap_or_default();
        let subscriber_facts = inputs.get(3).cloned().unwrap_or_default();

        let changed_ranges: Vec<(u64, u64)> = changed
            .get("ranges")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|range| {
                (
                    range.get("startIndex").and_then(Value::as_u64).unwrap_or(0),
                    range.get("endIndex").and_then(Value::as_u64).unwrap_or(0),
                )
            })
            .collect();
        let kind = update
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("no-change");
        let full_resync_policy = diff_policy
            .get("fullResync")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let max_ranges = diff_policy
            .get("maxPendingRanges")
            .and_then(Value::as_u64)
            .unwrap_or(64);
        let max_span = diff_policy
            .get("maxPendingSpanLines")
            .and_then(Value::as_u64)
            .unwrap_or(4096);
        let max_age = diff_policy
            .get("maxPendingAgeMs")
            .and_then(Value::as_u64)
            .unwrap_or(15_000);

        let truth_window_min = subscriber_facts
            .get("availableStartIndex")
            .and_then(Value::as_u64)
            .or_else(|| update.get("firstStartIndex").and_then(Value::as_u64))
            .unwrap_or(0);
        let truth_window_max = subscriber_facts
            .get("availableEndIndex")
            .and_then(Value::as_u64)
            .or_else(|| update.get("lastEndIndex").and_then(Value::as_u64))
            .unwrap_or(0);
        let out_of_bounds = changed_ranges
            .iter()
            .any(|(start, end)| *start < truth_window_min || *end > truth_window_max);
        let subscribers = subscriber_facts
            .get("subscribers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![json!({ "id": "default" })]);
        if subscribers.is_empty() {
            return Ok(json!({
                "fullResync": false,
                "subscribers": [],
                "updateClass": kind,
            }));
        }

        // Incoming changed ranges are diff truth; promotion to full-window
        // resync belongs to the daemon publisher's per-subscriber pending
        // bounds, not to this mirror-store diff projection.
        let initial_resync = full_resync_policy || out_of_bounds;
        let initial_reason = if full_resync_policy {
            Some("policy")
        } else if out_of_bounds {
            Some("range-bounds")
        } else {
            None
        };

        let mut plans = Vec::new();
        for subscriber in subscribers {
            let id = subscriber
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("default")
                .to_string();
            let backpressured = subscriber
                .get("backpressure")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || subscriber
                    .get("pendingTransportId")
                    .map(|value| value.as_str().is_none())
                    .unwrap_or(false);
            if backpressured {
                plans.push(json!({
                    "subscriberId": id,
                    "action": "hold",
                    "ranges": [],
                }));
                continue;
            }
            let mut full_resync = initial_resync;
            let mut resync_reason = initial_reason;
            let age_ms = subscriber
                .get("pendingSinceMs")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let pending_ranges = subscriber
                .get("pendingRanges")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let pending_len = pending_ranges.len() as u64;
            let pending_span = pending_ranges
                .iter()
                .map(|range| {
                    let start = range.get("startIndex").and_then(Value::as_u64).unwrap_or(0);
                    let end = range.get("endIndex").and_then(Value::as_u64).unwrap_or(0);
                    end.saturating_sub(start)
                })
                .max()
                .unwrap_or(0);
            if pending_len > max_ranges || pending_span > max_span || age_ms > max_age {
                full_resync = true;
                if resync_reason.is_none() {
                    resync_reason = if pending_len > max_ranges {
                        Some("subscriber-range-count")
                    } else if pending_span > max_span {
                        Some("subscriber-span-lines")
                    } else {
                        Some("pending-age")
                    };
                }
            }
            if kind == "head-only" || changed_ranges.is_empty() {
                plans.push(json!({
                    "subscriberId": id,
                    "action": "head-only",
                    "ranges": [],
                    "fullResync": full_resync,
                    "resyncReason": resync_reason,
                }));
                continue;
            }
            let mut merged = collapse_ranges(&changed_ranges);
            if full_resync {
                merged = vec![(truth_window_min, truth_window_max)];
            }
            plans.push(json!({
                "subscriberId": id,
                "action": if full_resync { "resync" } else { "body" },
                "ranges": merged.into_iter().map(range_to_json).collect::<Vec<_>>(),
                "fullResync": full_resync,
                "resyncReason": resync_reason,
            }));
        }
        Ok(json!({
            "fullResync": initial_resync,
            "resyncReason": initial_reason,
            "updateClass": kind,
            "subscribers": plans,
        }))
    }
}

struct BufferPublisherEmit;
impl Operator for BufferPublisherEmit {
    fn name(&self) -> &'static str {
        "daemon.buffer_publisher.emit"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let plan = obj(input);
        let subscribers = plan
            .get("subscribers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let plan_full_resync = plan
            .get("fullResync")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let plan_reason = plan.get("resyncReason").cloned().unwrap_or(Value::Null);
        let frames = subscribers
            .iter()
            .map(|subscriber| {
                let action = subscriber
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or("hold");
                let full_resync = subscriber
                    .get("fullResync")
                    .and_then(Value::as_bool)
                    .unwrap_or(plan_full_resync);
                let reason = subscriber
                    .get("resyncReason")
                    .cloned()
                    .unwrap_or_else(|| plan_reason.clone());
                let kind = if action == "head-only" {
                    "head"
                } else if action == "hold" {
                    "hold"
                } else {
                    "body"
                };
                json!({
                    "subscriberId": subscriber.get("subscriberId").cloned().unwrap_or(Value::Null),
                    "kind": kind,
                    "fullResync": full_resync,
                    "resyncReason": reason.clone(),
                    "action": action,
                    "changeKind": plan.get("updateClass").cloned().unwrap_or(Value::Null),
                    "ranges": subscriber.get("ranges").cloned().unwrap_or_else(|| Value::Array(vec![])),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "frames": frames }))
    }
}

struct ControlGatewayAuthenticate;
impl Operator for ControlGatewayAuthenticate {
    fn name(&self) -> &'static str {
        "daemon.control_gateway.authenticate"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let mut command = obj(input);
        let missing = ["commandId", "correlationId", "commandType", "subject"]
            .iter()
            .find(|key| !command.contains_key(**key));
        if let Some(key) = missing {
            return Err(format!("control ingress missing {key}"));
        }
        command.insert("authenticated".into(), Value::Bool(true));
        Ok(Value::Object(command))
    }
}

struct ControlCenterRoute;
impl Operator for ControlCenterRoute {
    fn name(&self) -> &'static str {
        "daemon.control_center.route"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let inputs = take_array(&input);
        let mut command = obj(inputs.first().cloned().unwrap_or_default());
        let policy = inputs.get(1).cloned().unwrap_or_default();
        let command_type = command
            .get("commandType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let owner = policy
            .get("ownerByCommand")
            .and_then(|owners| owners.get(command_type))
            .and_then(Value::as_str);
        let owner = match owner {
            Some(owner) => owner.to_string(),
            None => return Err(format!("unknown control command {command_type}")),
        };
        command.insert("ownerId".into(), json!(owner));
        Ok(Value::Object(command))
    }
}

struct ControlOwnerDispatch;
impl Operator for ControlOwnerDispatch {
    fn name(&self) -> &'static str {
        "daemon.control_owner.dispatch"
    }
    fn version(&self) -> &'static str {
        "0.1"
    }
    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        let command = obj(input);
        let owner_id = command
            .get("ownerId")
            .and_then(Value::as_str)
            .ok_or_else(|| "routed command missing ownerId".to_string())?;
        Ok(json!({
            "ok": true,
            "ownerId": owner_id,
            "commandType": command.get("commandType").cloned().unwrap_or(Value::Null),
        }))
    }
}
