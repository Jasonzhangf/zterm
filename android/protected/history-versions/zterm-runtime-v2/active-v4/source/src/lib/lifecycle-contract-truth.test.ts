import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type StateMachine = {
  initial: string;
  states: string[];
  transitions: Array<{ from: string; to: string; requirements: string[] }>;
};

const root = process.cwd();

function readContract(relativePath: string) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as unknown;
}

function assertStateMachine(machine: StateMachine, machineName: string) {
  expect(Array.isArray(machine.states), `${machineName}:states`).toBe(true);
  expect(machine.states.length, `${machineName}:states.length`).toBeGreaterThan(0);
  expect(machine.states.includes(machine.initial), `${machineName}:initial`).toBe(true);

  const states = new Set(machine.states);
  const transitions = new Map<string, string[]>();
  for (const transition of machine.transitions) {
    expect(states.has(transition.from), `${machineName}:from:${transition.from}`).toBe(true);
    expect(states.has(transition.to), `${machineName}:to:${transition.to}`).toBe(true);
    expect(Array.isArray(transition.requirements), `${machineName}:requirements`).toBe(true);
    const targets = transitions.get(transition.from) ?? [];
    targets.push(transition.to);
    transitions.set(transition.from, targets);
  }

  const reachable = new Set<string>([machine.initial]);
  const queue = [machine.initial];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of transitions.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const unreachable = machine.states.filter((state) => !reachable.has(state));
  expect(unreachable, `${machineName}:unreachable states`).toEqual([]);
}

describe('lifecycle contract truth gate', () => {
  it('loads lifecycle state machines and keeps every declared state reachable', () => {
    const schema = readContract('contracts/lifecycle-state-machines.json') as {
      $defs: { state_machine: unknown };
    };
    const manifest = readContract('contracts/lifecycle-state-machines.manifest.json') as Record<
      string,
      StateMachine
    >;

    expect(schema.$defs.state_machine).toBeTruthy();
    expect(Object.keys(manifest)).toEqual(['issue', 'library', 'source_snapshot', 'artifact']);
    for (const [machineName, machine] of Object.entries(manifest)) {
      assertStateMachine(machine, machineName);
    }
  });

  it('validates the goal clarification state machine', () => {
    const machine = readContract('contracts/goal-clarification-state-machine.json') as StateMachine;
    assertStateMachine(machine, 'goal-clarification');
  });

  it('keeps transition manifests machine-readable and duplicate names byte-identical', () => {
    const transitionFiles = readdirSync(join(root, 'contracts/transitions')).filter((entry) => (
      entry.endsWith('.json') && entry.includes('zone-transition')
    ));
    expect(transitionFiles.length, 'zone transition manifest files').toBeGreaterThan(0);

    const contents = transitionFiles.map((file) => (
      readFileSync(join(root, 'contracts/transitions', file), 'utf8')
    ));
    for (const content of contents.slice(1)) {
      expect(content).toBe(contents[0]);
    }

    const manifest = JSON.parse(contents[0]!) as {
      zones: string[];
      transitions: Array<{ from: string; to: string; allowed: boolean }>;
      forbidden_runtime_edges: Array<{ from: string; to: string }>;
    };
    const zones = new Set(manifest.zones);
    expect(manifest.zones.length, 'zones').toBeGreaterThan(0);
    for (const transition of manifest.transitions) {
      expect(zones.has(transition.from), `transition from:${transition.from}`).toBe(true);
      expect(zones.has(transition.to), `transition to:${transition.to}`).toBe(true);
    }
    for (const edge of manifest.forbidden_runtime_edges) {
      expect(zones.has(edge.from), `forbidden from:${edge.from}`).toBe(true);
    }
  });

  it('loads every record schema and keeps the record graph contract machine-readable', () => {
    const recordFiles = readdirSync(join(root, 'contracts/records')).filter((entry) => (
      entry.endsWith('.json')
    ));
    expect(recordFiles.length).toBeGreaterThan(0);

    for (const file of recordFiles) {
      const parsed = readContract(`contracts/records/${file}`) as {
        $id?: string;
        type?: string;
        required?: string[];
      };
      if (file === 'record-graph.contract.json') {
        expect(parsed.type).toBe('object');
        expect(parsed.required).toEqual(expect.arrayContaining(['rules', 'freshness_rules']));
      } else {
        expect(parsed.$id, file).toContain(`contracts/records/${file}`);
        expect(parsed.type, file).toBe('object');
        expect(parsed.required?.length, file).toBeGreaterThan(0);
      }
    }
  });
});
