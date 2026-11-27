import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

interface GraphPredicate {
  op: string
  field: string
  value?: unknown
}

interface GraphNode {
  id: string
  operator: string
  inputs: string[]
  output: { id: string }
  input_selector: { predicate: GraphPredicate | null }
}

interface GraphEdge {
  from: string
  to: string
  arc_id: string
}

interface Graph {
  inputs: { id: string }[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  outputs: string[]
}

const GRAPH_PATH = fileURLToPath(
  new URL('../../../../docs/dagpipe/graphs/accounts-authority.graph.json', import.meta.url),
)

function readGraph(): Graph {
  return JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Graph
}

function nodeByOperator(graph: Graph, operator: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.operator === operator)
  assert.ok(node, `missing graph operator ${operator}`)
  return node
}

function reaches(
  graph: Graph,
  from: string,
  to: string,
  skipped: ReadonlySet<string> = new Set(),
): boolean {
  const pending = [from]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop() as string
    if (current === to) return true
    if (visited.has(current) || skipped.has(current)) continue
    visited.add(current)
    for (const edge of graph.edges) {
      if (edge.from === current) pending.push(edge.to)
    }
  }
  return false
}

test('static Accounts graph routes malformed request rejection to the shared result', () => {
  const graph = readGraph()
  assert.equal(graph.inputs.length, 1)
  assert.equal(graph.outputs.length, 1)
  const validate = nodeByOperator(graph, 'accounts.request.validate')
  const execute = nodeByOperator(graph, 'accounts.authority.execute')
  const result = nodeByOperator(graph, 'accounts.result.project')
  assert.equal(
    reaches(graph, validate.id, result.id, new Set([execute.id])),
    true,
    'validation rejection must reach the shared result without passing authority execution',
  )
})

test('static Accounts graph classifies confirmed, rejected, failure and unknown outcomes', () => {
  const graph = readGraph()
  const expected = new Map([
    ['accounts.outcome.confirm', 'confirmed'],
    ['accounts.outcome.reject', 'rejected'],
    ['accounts.outcome.fail', 'failure'],
    ['accounts.outcome.unknown', 'unknown'],
  ])
  const classified = new Set<unknown>()
  for (const [operator, outcome] of expected) {
    const node = nodeByOperator(graph, operator)
    const predicate = node.input_selector.predicate
    assert.ok(predicate, `${operator} must classify its observed outcome input`)
    assert.equal(predicate.op, 'equals')
    assert.equal(predicate.field, 'outcome')
    assert.equal(predicate.value, outcome)
    assert.equal(classified.has(predicate.value), false, 'outcome classifications must be distinct')
    classified.add(predicate.value)
  }
})
