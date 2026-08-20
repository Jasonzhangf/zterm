export interface AndroidSessionNotificationDeepLink {
  targetKey: string;
  channelId: string;
  sessionName: string;
}

export type AndroidNotificationDeepLinkResult =
  | { kind: 'session-open'; value: AndroidSessionNotificationDeepLink }
  | { kind: 'other' }
  | { kind: 'invalid'; message: string };

export function parseAndroidNotificationDeepLink(url: unknown): AndroidNotificationDeepLinkResult {
  if (typeof url !== 'string' || !url.trim()) {
    return { kind: 'other' };
  }
  if (!url.startsWith('zterm://session/open')) {
    return { kind: 'other' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (parsedUrl.protocol !== 'zterm:' || parsedUrl.hostname !== 'session' || parsedUrl.pathname !== '/open') {
    return { kind: 'invalid', message: '通知中的会话链接格式不正确。' };
  }
  const targetKey = parsedUrl.searchParams.get('targetKey')?.trim() || '';
  const channelId = parsedUrl.searchParams.get('channelId')?.trim() || '';
  const sessionName = parsedUrl.searchParams.get('sessionName')?.trim() || '';
  if (!targetKey || !channelId || !sessionName) {
    return { kind: 'invalid', message: '通知中的会话链接缺少目标、通道或会话名称。' };
  }
  return {
    kind: 'session-open',
    value: { targetKey, channelId, sessionName },
  };
}
