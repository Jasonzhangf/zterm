/**
 * Submodule tests: traversal-relay server-helpers (relay.account_directory).
 */
import { describe, expect, it } from 'vitest';
import {
  asString,
  clientPeerLeaseKey,
  deviceKey,
  extractAccessToken,
  hostKey,
} from './server-helpers';

describe('traversal-relay server-helpers', () => {
  it('trims strings with empty fallback', () => {
    expect(asString('  x  ')).toBe('x');
    expect(asString(undefined)).toBe('');
    expect(asString(null)).toBe('');
    expect(asString(42)).toBe('');
  });

  it('builds composite keys', () => {
    expect(hostKey('u1', 'h1')).toBe('u1:h1');
    expect(deviceKey('u1', 'd1')).toBe('u1:d1');
    expect(clientPeerLeaseKey('u1', 'h1', 'd1')).toBe('u1:h1:d1');
    expect(clientPeerLeaseKey('u1', 'h1', '  ')).toBeNull();
  });

  it('extracts bearer tokens from the authorization header', () => {
    const request = { headers: { authorization: 'Bearer abc123' } } as never;
    expect(extractAccessToken(request, { searchParams: new URLSearchParams() } as never)).toBe('abc123');
  });

  it('extracts tokens from query params as fallback', () => {
    const request = { headers: {} } as never;
    const url = { searchParams: new URLSearchParams('token=tok-1') } as never;
    expect(extractAccessToken(request, url)).toBe('tok-1');
  });
});
