import { describe, expect, it, vi } from 'vitest';
import { createFileBrowserSessionPort } from './file-browser-session-port';

describe('file browser session port', () => {
  const session = { id: 's1', daemonHostId: 'daemon-1', bridgeHost: 'host', bridgePort: 3333 };

  it('binds one exact session and preserves the original wire object', () => {
    const target = { ...session };
    const send = vi.fn();
    const port = createFileBrowserSessionPort({ session: target, send, subscribe: vi.fn() });
    target.id = 's2';
    const message = { type: 'file-list-request' as const, payload: { requestId: 'req', path: '/work', showHidden: true } };
    port.sendJson(message);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('s1', message);
    expect(send.mock.calls[0][1]).toBe(message);
    expect(port.daemonFileScopeId).toBe('daemon:daemon-1');
  });

  it('uses the explicit endpoint file scope for a session without daemon identity', () => {
    const port = createFileBrowserSessionPort({
      session: { ...session, daemonHostId: undefined }, send: vi.fn(), subscribe: vi.fn(),
    });
    expect(port.daemonFileScopeId).toBe('endpoint:host:3333');
  });

  it('delegates subscription and exact cleanup without opening another transport', () => {
    const dispose = vi.fn();
    const subscribe = vi.fn(() => dispose);
    const send = vi.fn();
    const port = createFileBrowserSessionPort({ session, send, subscribe });
    const listener = vi.fn();
    expect(port.onFileTransferMessage(listener)).toBe(dispose);
    expect(subscribe).toHaveBeenCalledWith(listener);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects missing sessions and capabilities instead of falling back to active session', () => {
    expect(() => createFileBrowserSessionPort({ session: undefined, send: vi.fn(), subscribe: vi.fn() })).toThrow('session');
    expect(() => createFileBrowserSessionPort({ session: { ...session, id: '' }, send: vi.fn(), subscribe: vi.fn() })).toThrow('session');
    // @ts-expect-error Runtime boundary must reject absent sender.
    expect(() => createFileBrowserSessionPort({ session, subscribe: vi.fn() })).toThrow('send');
    // @ts-expect-error Runtime boundary must reject absent subscription.
    expect(() => createFileBrowserSessionPort({ session, send: vi.fn() })).toThrow('subscription');
  });

  it('propagates owner send failure', () => {
    const failure = new Error('transport closed');
    const port = createFileBrowserSessionPort({ session, send: () => { throw failure; }, subscribe: vi.fn() });
    expect(() => port.sendJson({ type: 'file-list-request', payload: { requestId: 'req', path: '/', showHidden: true } })).toThrow(failure);
  });
});
