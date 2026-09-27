import { describe, expect, it } from 'vitest';
import { normalizeTerminalCommittedText } from './terminal-input-normalization';
import { splitTerminalInputUtf8Chunks } from '@zterm/shared/terminal/input-chunking';
import { computeVisibleRangeRepairRanges } from '@zterm/shared/terminal/gap-repair-planner';
import { resolveRequestedBufferWindow } from '@zterm/shared/terminal/gap-utils';
import {
  runBufferManagement,
  runBufferRender,
  runConnectionLifecycle,
  runInputDispatch,
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

function line(text: string, index: number) {
  return { index, cells: Array.from(text).map(cell) };
}

function inputRequest(text: string) {
  return {
    execution_id: 'parity-input',
    attempt_id: '1',
    inputs: {
      'arc.committed_text': { text },
      'arc.input_policy': { chunkBytes: 64 * 1024, maxInFlight: 8 },
      'arc.transport_facts': { state: 'ready', bufferedBytes: 0 },
    },
  };
}

describe('DAGpipe Phase1 black-box parity with TypeScript owners', () => {
  it('normalizes committed text the same way as client.input_normalizer', () => {
    const raw = 'ab\r\ncd\u{3000}\u{ff41}\u{ff45}';
    const expected = normalizeTerminalCommittedText(raw);
    const result = runInputDispatch(inputRequest(raw));
    const sends = (result as { outputs: Record<string, { sends: Array<{ payload: { data: string } }> }> })
      .outputs['arc.mux_channel_send'].sends;
    expect(sends[0]?.payload.data).toBe(expected);
  });

  it('splits reliable input chunks the same way as shared input-chunking', () => {
    const raw = 'a'.repeat(70_000);
    const expected = splitTerminalInputUtf8Chunks(normalizeTerminalCommittedText(raw), 64 * 1024);
    const result = runInputDispatch(inputRequest(raw));
    const sends = (result as { outputs: Record<string, { sends: Array<{ payload: { data: string } }> }> })
      .outputs['arc.mux_channel_send'].sends;
    expect(sends.map((send) => send.payload.data)).toEqual(expected);
  });

  it('does not let a gap in the visible range erase already-known rows', () => {
    const tsGaps = computeVisibleRangeRepairRanges({
      visibleStartIndex: 0,
      visibleEndIndex: 3,
      localStartIndex: 1,
      localEndIndex: 2,
      localGapRanges: [],
    });
    expect(tsGaps).toEqual([{ startIndex: 0, endIndex: 1 }, { startIndex: 2, endIndex: 3 }]);

    // The Rust graph keeps the visible range projection anchored to the
    // renderer's declared range rather than fabricating rows from a gap.
    const result = runBufferRender({
      execution_id: 'parity-render',
      attempt_id: '1',
      inputs: {
        'arc.daemon_wire_frame': {
          revision: 2,
          startIndex: 1,
          endIndex: 2,
          rows: 24,
          cols: 80,
          lines: [line('b', 1)],
          cursor: null,
          cursorKeysApp: false,
        },
        'arc.visible_range_demand': {
          startIndex: 0,
          endIndex: 3,
          viewportRows: 24,
          mode: 'reading',
        },
        'arc.local_sparse_state': { startIndex: 0, endIndex: 0, gapRanges: [] },
        'arc.buffer_policy': {},
      },
    });
    const dom = (result as { outputs: Record<string, { startIndex: number }> })
      .outputs['arc.dom_commit'];
    expect(dom.startIndex).toBe(0);
  });

  it('keeps single physical transport and per-session body subscriptions for multi-session demands', () => {
    const result = runConnectionLifecycle({
      execution_id: 'parity-connection-multi',
      attempt_id: '1',
      inputs: {
        'arc.account_credentials': { accountId: 'u1', authToken: 'tok' },
        'arc.relay_settings': { relayEnabled: false },
        'arc.target_candidates': {
          candidates: [{ id: 'lan', path: 'LAN', endpoint: '10.0.0.1:3333' }],
        },
        'arc.session_demand_set': {
          sessions: [
            { sessionId: 's1', sessionName: 'one', mode: 'active' },
            { sessionId: 's2', sessionName: 'two', mode: 'inactive' },
          ],
        },
        'arc.connection_policy': { pathPriority: ['LAN', 'Relay'], expectedGeneration: 1 },
      },
    });
    const health = (result as { outputs: Record<string, { targetKey: string; generation: number }> })
      .outputs['arc.connection_health'];
    const subscriptions = (result as { outputs: Record<string, { subscriptions: Array<{ sessionId: string; bodySubscribed: boolean }> }> })
      .outputs['arc.body_subscriptions'];
    expect(health.targetKey).toBe('lan');
    expect(health.generation).toBe(1);
    expect(subscriptions.subscriptions).toHaveLength(2);
    expect(subscriptions.subscriptions).toEqual([
      { sessionId: 's1', bodySubscribed: true, channelId: 'ch-lan-s1', mode: 'active' },
      { sessionId: 's2', bodySubscribed: false, channelId: 'ch-lan-s2', mode: 'inactive' },
    ]);
  });

  it('matches active buffer window planning against shared gap utilities', () => {
    const expected = resolveRequestedBufferWindow(100, 24, 40, 0);
    const result = runBufferManagement({
      execution_id: 'parity-buffer-window',
      attempt_id: '1',
      inputs: {
        'arc.daemon_head_facts': {
          sessions: [{ sessionId: 's1', revision: 4, latestEndIndex: 100 }],
        },
        'arc.session_buffer_demand': {
          sessions: [{ sessionId: 's1', mode: 'active', viewportRows: 24 }],
        },
        'arc.local_buffer_state': {
          sessions: [{ sessionId: 's1', revision: 0, startIndex: 0, endIndex: 0, gapRanges: [] }],
        },
        'arc.buffer_policy': { cacheLines: 40 },
      },
    });
    const requests = (result as { outputs: Record<string, { requests: Array<{ sessionId: string; startIndex: number; endIndex: number }> }> })
      .outputs['arc.range_requests'];
    expect(requests.requests[0]?.startIndex).toBe(expected.requestStartIndex);
    expect(requests.requests[0]?.endIndex).toBe(expected.requestEndIndex);
    expect(requests.requests[0]?.sessionId).toBe('s1');
  });

  it('does not publish a blank DOM commit when frame assembly is incomplete', () => {
    const result = runBufferRender({
      execution_id: 'parity-incomplete-frame',
      attempt_id: '1',
      inputs: {
        'arc.daemon_wire_frame': {
          revision: 5,
          startIndex: 2,
          endIndex: 3,
          frameStartIndex: 0,
          frameEndIndex: 3,
          frameChunkIndex: 0,
          frameChunkCount: 2,
          rows: 24,
          cols: 80,
          lines: [line('a', 0), line('b', 2)],
          cursor: null,
          cursorKeysApp: false,
        },
        'arc.visible_range_demand': { startIndex: 0, endIndex: 3, viewportRows: 24, mode: 'follow' },
        'arc.local_sparse_state': {
          startIndex: 0,
          endIndex: 2,
          gapRanges: [],
          lines: [line('known', 0), line('still-here', 1)],
        },
        'arc.buffer_policy': {},
      },
    });
    const dom = (result as { outputs: Record<string, { rows: string[] }> })
      .outputs['arc.dom_commit'];
    expect(dom.rows[0]).toContain('known');
    expect(dom.rows[1]).toContain('still-here');
  });

  it('does not drop a repair range when the visible range is ahead of local sparse truth', () => {
    const expectedRanges = computeVisibleRangeRepairRanges({
      visibleStartIndex: 0,
      visibleEndIndex: 3,
      localStartIndex: 1,
      localEndIndex: 2,
      localGapRanges: [],
    });
    expect(expectedRanges).toEqual([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 2, endIndex: 3 },
    ]);

    const result = runBufferRender({
      execution_id: 'parity-repair-ledger',
      attempt_id: '1',
      inputs: {
        'arc.daemon_wire_frame': {
          revision: 3,
          startIndex: 1,
          endIndex: 2,
          rows: 24,
          cols: 80,
          lines: [line('b', 1)],
          cursor: null,
          cursorKeysApp: false,
        },
        'arc.visible_range_demand': { startIndex: 0, endIndex: 3, viewportRows: 24, mode: 'reading' },
        'arc.local_sparse_state': { startIndex: 1, endIndex: 2, gapRanges: [] },
        'arc.buffer_policy': {},
      },
    });
    const syncRequest = (result as { outputs: Record<string, { repairRanges: Array<{ startIndex: number; endIndex: number }> }> })
      .outputs['arc.buffer_sync_request'];
    expect(syncRequest.repairRanges).toEqual(expectedRanges);
  });

  it('ingests real wire responses and clears the repair ledger', () => {
    const result = runBufferManagement({
      execution_id: 'parity-buffer-wire',
      attempt_id: '1',
      inputs: {
        'arc.daemon_head_facts': {
          sessions: [{ sessionId: 's1', revision: 1, latestEndIndex: 2 }],
        },
        'arc.session_buffer_demand': {
          sessions: [{ sessionId: 's1', mode: 'active', viewportRows: 24 }],
        },
        'arc.local_buffer_state': {
          sessions: [{ sessionId: 's1', revision: 0, startIndex: 0, endIndex: 0, gapRanges: [] }],
        },
        'arc.buffer_policy': { cacheLines: 100, dispatchBudget: 4 },
        'arc.wire_range_responses': {
          responses: [{ sessionId: 's1', startIndex: 0, endIndex: 2 }],
        },
      },
    });
    const outputs = (result as { outputs: Record<string, { scopes?: Array<{ visible?: boolean }>; ledger?: Array<{ status?: string }> }> }).outputs;
    expect(outputs['arc.render_scope'].scopes?.[0].visible).toBe(true);
    expect(outputs['arc.repair_ledger'].ledger?.[0].status).toBe('none');
  });

  it('does not emit input when the transport is under backpressure', () => {
    const result = runInputDispatch({
      execution_id: 'parity-backpressure',
      attempt_id: '1',
      inputs: {
        'arc.committed_text': { text: 'hello' },
        'arc.input_policy': { chunkBytes: 64 * 1024, maxInFlight: 8 },
        'arc.transport_facts': { state: 'ready', bufferedBytes: 200000 },
      },
    });
    const sends = (result as { outputs: Record<string, { sends?: Array<unknown>; droppedToBackpressure?: boolean }> }).outputs[
      'arc.mux_channel_send'
    ];
    expect(sends.droppedToBackpressure).toBe(true);
    expect(sends.sends?.length ?? 0).toBe(0);
  });
});
