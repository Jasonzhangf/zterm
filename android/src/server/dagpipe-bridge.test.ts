import { describe, expect, it } from 'vitest';
import { compilePhase0, runMirrorPublish, runControlDispatch } from './dagpipe-bridge';
import { findChangedIndexedRanges } from './canonical-buffer';

function cell(ch: string) {
  const codePoint = Array.from(ch)[0]?.codePointAt(0) ?? 32;
  return { char: codePoint, fg: 256, bg: 256, flags: 0, width: 1 };
}

function line(text: string) {
  return Array.from(text).map((ch) => cell(ch));
}

function mirrorRequest(prevLines: string[], nextLines: string[], diffPolicy = {}, subscriberFacts = {}) {
  return {
    execution_id: 'client-bridge-test',
    attempt_id: '1',
    inputs: {
      'arc.source_readback': {
        revision: 4,
        bufferStartIndex: 0,
        bufferLines: nextLines.map(line),
        rows: Math.max(3, nextLines.length),
        cols: 20,
        cursorKeysApp: false,
        cursor: null,
      },
      'arc.diff_policy': diffPolicy,
      'arc.prev_mirror_snapshot': {
        revision: 3,
        bufferStartIndex: 0,
        bufferLines: prevLines.map(line),
      },
      'arc.subscriber_facts': {
        availableStartIndex: 0,
        availableEndIndex: nextLines.length,
        ...subscriberFacts,
      },
    },
  };
}

function frameRanges(result: ReturnType<typeof runMirrorPublish>) {
  const frames = (result as { ok: true; outputs: Record<string, { frames: Array<{ ranges: Array<{ startIndex: number; endIndex: number }> }> }> })
    .outputs['arc.wire_frames'].frames;
  return frames[0]?.ranges ?? [];
}

describe('dagpipe bridge parity', () => {
  it('compiles phase0 daemon graphs', () => {
    expect(compilePhase0()).toMatchObject({ ok: true });
  });

  it('publishes appended tail without holes', () => {
    const result = runMirrorPublish(mirrorRequest(['a', 'b'], ['a', 'b', 'c']));
    expect(result.ok).toBe(true);
    const frames = (result as { ok: true; outputs: Record<string, { frames: Array<Record<string, any>> }> })
      .outputs['arc.wire_frames'].frames;
    expect(frames[0]?.changeKind).toBe('append');
    expect(frames[0]?.ranges).toEqual([{ startIndex: 2, endIndex: 3 }]);
  });

  it('rewrites old lines with a no-hole span', () => {
    const result = runMirrorPublish(mirrorRequest(['a', 'b', 'c'], ['a', 'X', 'c']));
    const frames = (result as { ok: true; outputs: Record<string, { frames: Array<Record<string, any>> }> })
      .outputs['arc.wire_frames'].frames;
    expect(frames[0]?.changeKind).toBe('rewrite');
    expect(frames[0]?.ranges).toEqual([{ startIndex: 1, endIndex: 2 }]);
  });

  it('emits head-only frames when body is unchanged', () => {
    const result = runMirrorPublish(mirrorRequest(['a', 'b'], ['a', 'b']));
    const frames = (result as { ok: true; outputs: Record<string, { frames: Array<Record<string, any>> }> })
      .outputs['arc.wire_frames'].frames;
    expect(frames[0]?.action).toBe('head-only');
    expect(frames[0]?.kind).toBe('head');
  });

  it('holds a backpressured subscriber', () => {
    const result = runMirrorPublish(mirrorRequest(
      ['a', 'b'],
      ['a', 'b', 'c'],
      {},
      { subscribers: [{ id: 's1', backpressure: true }] },
    ));
    const frames = (result as { ok: true; outputs: Record<string, { frames: Array<Record<string, any>> }> })
      .outputs['arc.wire_frames'].frames;
    expect(frames[0]?.action).toBe('hold');
  });

  it('matches findChangedIndexedRanges for a broad rewrite over 4096 lines', () => {
    const prevLines = Array.from({ length: 5_000 }, (_, index) => `line-${index}`);
    const nextLines = prevLines.map((value, index) => (index < 4_200 ? `changed-${index}` : value));
    const expected = findChangedIndexedRanges({
      previousStartIndex: 0,
      previousLines: prevLines.map(line),
      nextStartIndex: 0,
      nextLines: nextLines.map(line),
    });
    const result = runMirrorPublish(mirrorRequest(prevLines, nextLines));
    expect(frameRanges(result)).toEqual(expected);
  });

  it('matches findChangedIndexedRanges with more than 64 sparse ranges', () => {
    const prevLines = Array.from({ length: 200 }, (_, index) => `line-${index}`);
    const nextLines = prevLines.map((value, index) => (index % 2 === 0 ? `changed-${index}` : value));
    const expected = findChangedIndexedRanges({
      previousStartIndex: 0,
      previousLines: prevLines.map(line),
      nextStartIndex: 0,
      nextLines: nextLines.map(line),
    });
    const result = runMirrorPublish(mirrorRequest(prevLines, nextLines));
    expect(frameRanges(result)).toEqual(expected);
  });

  it('dispatches valid control commands', () => {
    const result = runControlDispatch({
      execution_id: 'control-bridge-test',
      attempt_id: '1',
      inputs: {
        'arc.control_ingress': {
          commandId: 'c1',
          correlationId: 'c1',
          commandType: 'schedule-list',
          subject: 'session',
        },
        'arc.capability_policy': {
          ownerByCommand: {
            'schedule-list': 'daemon.control_center:schedule-list',
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect((result as { outputs: Record<string, { ok: boolean; ownerId: string }> })
      .outputs['arc.control_result']?.ownerId).toBe('daemon.control_center:schedule-list');
  });

  it('returns typed control errors instead of throwing', () => {
    const result = runControlDispatch({
      execution_id: 'control-bridge-test',
      attempt_id: '1',
      inputs: {
        'arc.control_ingress': {
          commandId: 'c1',
          correlationId: 'c1',
          commandType: 'unknown-command',
          subject: 'session',
        },
        'arc.capability_policy': {
          ownerByCommand: {
            'schedule-list': 'daemon.control_center:schedule-list',
          },
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
