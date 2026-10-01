import { useCallback } from 'react';
import type { Host } from '../lib/types';
import { buildBridgeTargetFromHost } from '../lib/session-picker';

export interface VerificationSessionOpenOptions {
  hosts: Host[];
  sessionName?: string;
  onOpenSession: (host: Host, sessionName: string) => void;
  onError?: (message: string) => void;
}

export function resolveVerificationHost(hosts: Host[], sessionName = 'default'): Host | null {
  return hosts.find((host) => (host.sessionName || 'default') === sessionName)
    || hosts
      .slice()
      .sort((left, right) => (right.lastConnected ?? 0) - (left.lastConnected ?? 0))
      .find((host) => (host.lastConnected ?? 0) > 0)
    || hosts[0]
    || null;
}

export function useVerificationSessionOpen(): {
  openVerificationSession: (options: VerificationSessionOpenOptions) => void;
} {
  const openVerificationSession = useCallback((options: VerificationSessionOpenOptions) => {
    const sessionName = options.sessionName || 'default';
    const host = resolveVerificationHost(options.hosts, sessionName);
    if (!host) {
      options.onError?.('未找到可打开验证会话的连接。请先在设置中添加连接。');
      return;
    }
    options.onOpenSession(host, sessionName);
  }, []);

  return { openVerificationSession };
}

export function buildVerificationSessionTarget(host: Host) {
  return buildBridgeTargetFromHost(host);
}
