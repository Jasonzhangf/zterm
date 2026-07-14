import { describe, expect, it } from 'vitest';
import { buildOpenTabSessionCreateOptions, resolveOpenTabOpenPolicy } from './open-tab-open-policy';

describe('open-tab open policy', () => {
  it('keeps only explicit current-process open and non-connecting cold-restore compatibility policies', () => {
    expect(resolveOpenTabOpenPolicy('explicit-open')).toEqual({
      connectOnCreate: true,
      clearClosedReuseOnOpen: true,
    });
    expect(resolveOpenTabOpenPolicy('cold-restore')).toEqual({
      connectOnCreate: false,
      clearClosedReuseOnOpen: false,
    });
  });

  it('builds create options without any saved-tab import source', () => {
    expect(buildOpenTabSessionCreateOptions('explicit-open', {
      customName: 'Demo',
      createdAt: 123,
      sessionId: 'session-1',
    })).toEqual({
      activate: false,
      connect: true,
      customName: 'Demo',
      createdAt: 123,
      sessionId: 'session-1',
    });
  });
});
