import { describe, expect, it } from 'vitest';
import {
  compilePhase0,
  compilePhase2,
  readDagpipeInputChunks,
  runBufferManagement,
  runBufferRender,
  runConnectionLifecycle,
  runInputDispatch,
  runPhase2Relay,
  runPhase2DaemonConnection,
} from './dagpipe-bridge';

function cell(ch: string) {
  return {
    char: ch.codePointAt(0) ?? 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function line(text: string, index = 0) {
  return { index, cells: Array.from(text).map(cell) };
}

describe('dagpipe native bridge', () => {
  it('compiles all Phase0 graphs from the native core', () => {
    expect(compilePhase0()).toEqual({
      ok: true,
      graphs: [
        'android.connection_lifecycle@0.1',
        'android.buffer_management@0.1',
        'android.buffer_render@0.1',
        'android.input_dispatch@0.1',
        'daemon.mirror_publish@0.2',
        'daemon.control_dispatch@0.1',
      ],
    });
  });

  it('compiles Phase2 relay and daemon connection catalog graphs', () => {
    expect(compilePhase2()).toEqual({
      ok: true,
      graphs: [
        'relay.account_peer_route@0.1',
        'daemon.connection_channel_catalog@0.1',
      ],
    });
  });

  it('routes relay login to a resume plan through the native core', () => {
    const result = runPhase2Relay({
      execution_id: 'bridge-phase2-relay',
      attempt_id: '1',
      inputs: {
        'arc.account_credentials': { accountId: 'u1', authToken: 'tok' },
        'arc.relay_settings': { relayEnabled: true },
        'arc.device_capabilities': {
          deviceId: 'device-a',
          platform: 'android',
          routes: ['relay'],
        },
        'arc.route_policy': { pathPriority: ['relay'] },
      },
    });
    const resume = (result as { outputs: Record<string, { state: string; action: string }> })
      .outputs['arc.resume_plan'];
    expect(resume.state).toBe('ready');
    expect(resume.action).toBe('resume');
  });

  it('builds daemon connection catalog and idle facts', () => {
    const result = runPhase2DaemonConnection({
      execution_id: 'bridge-phase2-daemon',
      attempt_id: '1',
      inputs: {
        'arc.physical_connection': { connectionId: 'conn-1' },
        'arc.mux_capabilities': { muxEnabled: true },
        'arc.session_catalog_request': { sessionNames: [{ sessionId: 's1' }] },
        'arc.idle_facts_request': {},
      },
    });
    const catalog = (result as { outputs: Record<string, { state: string }> })
      .outputs['arc.session_catalog'];
    const idle = (result as { outputs: Record<string, { state: string }> })
      .outputs['arc.idle_facts'];
    expect(catalog.state).toBe('ready');
    expect(idle.state).toBe('published');
  });

  it('routes committed text through the input dispatch graph', () => {
    const result = runInputDispatch({
      execution_id: 'bridge-input',
      attempt_id: '1',
      inputs: {
        'arc.committed_text': { text: 'ab\r\ncd' },
        'arc.input_policy': { chunkBytes: 64, maxInFlight: 8 },
        'arc.transport_facts': { state: 'ready', bufferedBytes: 0 },
      },
    });
    const send = (result as { outputs: Record<string, { sends: Array<{ payload: { data: string } }> }> })
      .outputs['arc.mux_channel_send'];
    expect(send.sends[0]?.payload.data).toBe('ab cd');
  });

  it('plans every UTF-8 chunk without dropping beyond maxInFlight', () => {
    const text = 'a'.repeat(80_000);
    const result = runInputDispatch({
      execution_id: 'bridge-input-large',
      attempt_id: '1',
      inputs: {
        'arc.committed_text': { text },
        'arc.input_policy': { chunkBytes: 64 * 1024, maxInFlight: text.length + 1 },
        'arc.transport_facts': { state: 'ready', bufferedBytes: 0 },
      },
    });
    const chunks = readDagpipeInputChunks(result);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });

  it('applies a complete buffer frame and projects DOM rows', () => {
    const result = runBufferRender({
      execution_id: 'bridge-render',
      attempt_id: '1',
      inputs: {
        'arc.daemon_wire_frame': {
          revision: 3,
          startIndex: 0,
          endIndex: 2,
          rows: 24,
          cols: 80,
          lines: [line('a', 0), line('b', 1)],
          cursor: null,
          cursorKeysApp: false,
        },
        'arc.visible_range_demand': {
          startIndex: 0,
          endIndex: 2,
          viewportRows: 24,
          mode: 'follow',
        },
        'arc.local_sparse_state': { startIndex: 0, endIndex: 0, gapRanges: [] },
        'arc.buffer_policy': {},
      },
    });
    const dom = (result as { outputs: Record<string, { rows: string[]; revision: number }> })
      .outputs['arc.dom_commit'];
    expect(dom.rows).toEqual(['a', 'b']);
    expect(dom.revision).toBe(3);
  });

  it('keeps inactive sessions out of render scope', () => {
    const result = runBufferManagement({
      execution_id: 'bridge-buffer',
      attempt_id: '1',
      inputs: {
        'arc.daemon_head_facts': {
          sessions: [{ sessionId: 's1', revision: 1, latestEndIndex: 5 }],
        },
        'arc.session_buffer_demand': {
          sessions: [{ sessionId: 's1', mode: 'inactive' }],
        },
        'arc.local_buffer_state': {
          sessions: [{ sessionId: 's1', revision: 0, startIndex: 0, endIndex: 0 }],
        },
        'arc.buffer_policy': { cacheLines: 100 },
      },
    });
    const scopes = (result as { outputs: Record<string, { scopes: Array<{ visible: boolean }> }> })
      .outputs['arc.render_scope'].scopes;
    expect(scopes[0]?.visible).toBe(false);
  });

  it('plans recovery without dropping sessions', () => {
    const result = runConnectionLifecycle({
      execution_id: 'bridge-connection',
      attempt_id: '1',
      inputs: {
        'arc.account_credentials': { accountId: 'u1', authToken: 'tok' },
        'arc.relay_settings': { relayEnabled: true },
        'arc.target_candidates': {
          candidates: [{ id: 'lan', path: 'LAN', endpoint: '10.0.0.1' }],
        },
        'arc.session_demand_set': {
          sessions: [
            { sessionId: 's1', sessionName: 'one' },
            { sessionId: 's2', sessionName: 'two' },
          ],
        },
        'arc.connection_policy': {
          pathPriority: ['LAN', 'UDP direct', 'Tailscale', 'Relay'],
          expectedGeneration: 1,
        },
      },
    });
    const plan = (result as {
      outputs: Record<string, { recoveryNeeded: boolean; preserveSessions: boolean }>;
    }).outputs['arc.recovery_plan'];
    expect(plan.recoveryNeeded).toBe(false);
    expect(plan.preserveSessions).toBe(true);
  });
});
