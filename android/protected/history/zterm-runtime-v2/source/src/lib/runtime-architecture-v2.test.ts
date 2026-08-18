import { describe, expect, it } from 'vitest';
import { createControlCommand, controlPlaneBrand } from '@zterm/shared/terminal/control-contract';
import { createDataEnvelope, dataPlaneBrand } from '@zterm/shared/terminal/node-contract';
import {
  classifyTerminalMuxClientMessage,
  isTerminalMuxClientFrame,
} from '@zterm/shared/protocol';

describe('runtime architecture v2 production invariants', () => {
  it('keeps data and control envelopes branded as separate planes', () => {
    const data = createDataEnvelope('rows', 1, []);
    const control = createControlCommand('resize', 'command-1', 'correlation-1', { cols: 80 });

    expect(data[dataPlaneBrand]).toBe(true);
    expect(control[controlPlaneBrand]).toBe(true);
    expect(controlPlaneBrand in data).toBe(false);
    expect(dataPlaneBrand in control).toBe(false);
  });

  it('keeps debug observability off the mux channel without throwing from the frame predicate', () => {
    expect(classifyTerminalMuxClientMessage({ type: 'debug-log' } as never)).toBe('observability');
    expect(classifyTerminalMuxClientMessage({ type: 'debug-snapshot' } as never)).toBe('observability');
    expect(isTerminalMuxClientFrame({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: { type: 'debug-log' },
      },
    })).toBe(false);
  });
});
