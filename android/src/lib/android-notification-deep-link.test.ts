import { describe, expect, it } from 'vitest';
import { parseAndroidNotificationDeepLink } from './android-notification-deep-link';

describe('parseAndroidNotificationDeepLink', () => {
  it('parses a complete session action link', () => {
    expect(parseAndroidNotificationDeepLink(
      'zterm://session/open?targetKey=daemon%3Amac&channelId=channel-1&sessionName=shell',
    )).toEqual({
      kind: 'session-open',
      value: {
        targetKey: 'daemon:mac',
        channelId: 'channel-1',
        sessionName: 'shell',
      },
    });
  });

  it('rejects malformed and incomplete session links', () => {
    expect(parseAndroidNotificationDeepLink('zterm://session/open?targetKey=%')).toMatchObject({
      kind: 'invalid',
    });
    expect(parseAndroidNotificationDeepLink(
      'zterm://session/open?targetKey=daemon%3Amac&sessionName=shell',
    )).toEqual({
      kind: 'invalid',
      message: '通知中的会话链接缺少目标、通道或会话名称。',
    });
  });

  it('does not claim unrelated app URLs', () => {
    expect(parseAndroidNotificationDeepLink('zterm://connection/import?payload=abc')).toEqual({
      kind: 'other',
    });
    expect(parseAndroidNotificationDeepLink(null)).toEqual({ kind: 'other' });
  });
});
