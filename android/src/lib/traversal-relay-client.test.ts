// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeTraversalRelayBaseUrl,
  readTraversalRelayAccountState,
} from './traversal-relay-client';

describe('traversal relay client truth', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
  });

  it('normalizes relay base url to canonical /relay/ root', () => {
    expect(normalizeTraversalRelayBaseUrl('https://coder2.codewhisper.cc')).toBe(
      'https://coder2.codewhisper.cc/relay/',
    );
    expect(normalizeTraversalRelayBaseUrl('https://coder2.codewhisper.cc/relay/devices')).toBe(
      'https://coder2.codewhisper.cc/relay/',
    );
  });

  it('logs and returns null when stored relay account payload is invalid json', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.localStorage.setItem('zterm:traversal-relay-account', '{bad-json');

    expect(readTraversalRelayAccountState()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[traversal-relay-client] Failed to read account state:',
      expect.any(SyntaxError),
    );

    errorSpy.mockRestore();
  });
});
