import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + 420);
}

describe('server transport/session lifecycle truth gates', () => {
  it('keeps control transport separate from session transport attach flow', () => {
    const source = readServerSource();
    expect(source).toContain("case 'session-open'");
    expect(source).toContain("type: 'session-ticket'");
    expect(source).toContain('takeSessionTransportTicket');
  });

  it('does not keep websocket-close grace timers that auto-close logical sessions', () => {
    const source = readServerSource();
    expect(source).not.toContain('_detachTimer');
    expect(source).not.toContain('grace expired');
    expect(source).not.toContain('grace timer handles cleanup');
  });

  it('detaches bound websocket transports instead of closing logical sessions on ws close/error', () => {
    const source = readServerSource();
    const closeBlock = extractBlock(source, "ws.on('close'");
    const errorBlock = extractBlock(source, "ws.on('error'");
    expect(closeBlock).toContain("if (session?.logicalSessionBound)");
    expect(closeBlock).toContain("detachClientSessionTransportOnly(session, 'websocket closed'");
    expect(closeBlock).not.toContain("closeLogicalClientSession(session, 'websocket closed', false)");
    expect(errorBlock).toContain("if (session?.logicalSessionBound)");
    expect(errorBlock).toContain("detachClientSessionTransportOnly(session, `websocket error: ${error.message}`");
    expect(errorBlock).not.toContain("closeLogicalClientSession(session, `websocket error: ${error.message}`, false)");
  });

  it('detaches bound rtc transports instead of closing logical sessions on rtc close/error', () => {
    const source = readServerSource();
    const rtcCloseBlock = extractBlock(source, 'onClose: (_transportId, reason) =>');
    const rtcErrorBlock = extractBlock(source, 'onError: (_transportId, message) =>');
    expect(rtcCloseBlock).toContain('if (session?.logicalSessionBound)');
    expect(rtcCloseBlock).toContain('detachClientSessionTransportOnly(session, reason');
    expect(rtcCloseBlock).not.toContain('closeLogicalClientSession(session, reason, false)');
    expect(rtcErrorBlock).toContain('if (session?.logicalSessionBound)');
    expect(rtcErrorBlock).toContain('detachClientSessionTransportOnly(session, `rtc error: ${message}`');
    expect(rtcErrorBlock).not.toContain('closeLogicalClientSession(session, `rtc error: ${message}`, false)');
  });
});
