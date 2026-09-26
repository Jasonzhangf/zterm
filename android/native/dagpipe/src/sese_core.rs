//! Shared SESE adapters used by every project Graph migrated to the DAGpipe
//! single-input/single-output contract.
//!
//! A Graph now exposes one request ARC and one result ARC. The request extract
//! nodes rebuild the original module ARCs from caller inputs, and the result
//! collect node bundles the original module outputs into one result ARC.
//! The run helpers in each phase unwrap that result ARC back to the historical
//! output contract so bridge callers do not change shape.

use pipeline_runtime::*;
use serde_json::{Map, Value};
use std::collections::HashMap;

const EXTRACT_PREFIX: &str = "dagpipe.extract.";
const COLLECT_PREFIX: &str = "dagpipe.collect.";

struct RequestExtract;

impl Operator for RequestExtract {
    fn name(&self) -> &'static str {
        "dagpipe.request.extract"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Any
    }

    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let request = input
            .as_object()
            .ok_or("dagpipe extract requires an object input")?;
        let field = context
            .node_id
            .strip_prefix(EXTRACT_PREFIX)
            .ok_or_else(|| format!("invalid extract node id `{}`", context.node_id))?;
        request
            .get(field)
            .cloned()
            .ok_or_else(|| format!("dagpipe request is missing extracted field `{field}`"))
    }
}

struct ResultCollect;

impl Operator for ResultCollect {
    fn name(&self) -> &'static str {
        "dagpipe.result.collect"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Any
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let values = match input {
            Value::Array(items) => items,
            other => vec![other],
        };
        let keys: Vec<&str> = context
            .node_id
            .strip_prefix(COLLECT_PREFIX)
            .ok_or_else(|| format!("invalid collect node id `{}`", context.node_id))?
            .split(',')
            .collect();
        if keys.len() != values.len() {
            return Err(format!(
                "dagpipe result collect arity mismatch for `{}`: keys={} values={}",
                context.node_id,
                keys.len(),
                values.len()
            ));
        }
        let mut result = Map::new();
        for (key, value) in keys.into_iter().zip(values) {
            result.insert(key.to_string(), value);
        }
        Ok(Value::Object(result))
    }
}

pub fn register_sese_operators(registry: &mut Registry) {
    registry
        .register(RequestExtract)
        .expect("register dagpipe.request.extract");
    registry
        .register(ResultCollect)
        .expect("register dagpipe.result.collect");
}

/// Builds the single request ARC from caller-supplied legacy module arcs when
/// the graph contains request-extract nodes. Returns true when wrapping was
/// applied; callers leave `inputs` otherwise untouched.
pub fn wrap_request_inputs(graph_json: &Value, inputs: &mut HashMap<String, Value>) -> bool {
    let Some(nodes) = graph_json.get("nodes").and_then(Value::as_array) else {
        return false;
    };
    let fields: Vec<String> = nodes
        .iter()
        .filter(|node| {
            node.get("operator")
                .and_then(Value::as_str)
                .is_some_and(|op| op == "dagpipe.request.extract")
        })
        .filter_map(|node| {
            node.get("id")
                .and_then(Value::as_str)
                .and_then(|id| id.strip_prefix(EXTRACT_PREFIX))
                .map(|field| field.to_string())
        })
        .collect();
    if fields.is_empty() {
        return false;
    }
    let mut request = Map::new();
    for field in fields {
        let value = inputs
            .remove(&field)
            .unwrap_or_else(|| Value::Object(Map::new()));
        request.insert(field, value);
    }
    inputs.insert("arc.request".to_string(), Value::Object(request));
    true
}

/// Converts a DAGpipe result ARC back into the historical output ARC map so
/// existing Rust and TypeScript callers keep reading the same output keys.
pub fn unwrap_result_outputs(outputs: &HashMap<String, ArcValue>) -> HashMap<String, ArcValue> {
    let Some(result_arc) = outputs.get("arc.result") else {
        return outputs.clone();
    };
    let Some(result) = result_arc.payload.as_object() else {
        return outputs.clone();
    };
    let mut legacy = outputs
        .iter()
        .filter(|(id, _)| id.as_str() != "arc.result")
        .map(|(id, arc)| (id.clone(), arc.clone()))
        .collect::<HashMap<String, ArcValue>>();
    for (id, payload) in result {
        legacy.insert(
            id.clone(),
            ArcValue {
                id: id.clone(),
                version: result_arc.version,
                schema: ValueType::Any,
                payload: payload.clone(),
            },
        );
    }
    legacy
}
