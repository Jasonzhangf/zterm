import { describe, expect, it } from 'vitest';
import type {
  RemoteWindowContinuousSamplePayload,
  RemoteWindowTimedGestureActionPayload,
} from '@zterm/shared/protocol';

describe('remote window input Action/Sample contract', () => {
  it('makes Action deadline and Sample timestamp structurally distinct', () => {
    const action = {
      streamId: 'stream-1',
      targetId: 'target-1',
      deliveryKind: 'action',
      sampledAtMs: 100,
      deadlineMs: 200,
      event: { kind: 'close-window' },
    } satisfies RemoteWindowTimedGestureActionPayload;
    const sample = {
      streamId: 'stream-1',
      targetId: 'target-1',
      deliveryKind: 'sample',
      sampledAtMs: 101,
      event: {
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 1,
        x: 10,
        y: 10,
        normalizedX: 0.1,
        normalizedY: 0.1,
      },
    } satisfies RemoteWindowContinuousSamplePayload;

    expect(action.deliveryKind).toBe('action');
    expect(sample.deliveryKind).toBe('sample');
    expect('deadlineMs' in sample).toBe(false);
  });
});
