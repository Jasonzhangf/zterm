import { getBrowserStorage, type BrowserStorageLike } from './browser-storage';

// 客户端本地「最近成功连接过哪些 daemon」的记忆。
//
// 背景：判活不能只依赖服务端目录 lastSeenAt——未升级的 daemon 不会定期 publish，
// lastSeenAt 停在启动时刻，会被 ONLINE_DAEMON_FRESHNESS_MS 误杀（抽屉看不到在线机器）。
// 本客户端自己真实连通过的 daemon（服务端握手 connected 消息里的 daemonHostId）
// 是「这台机器活着」的最强证据，与目录新鲜度互为补充：
//   fresh(lastSeenAt <= 15min) || 本客户端 7 天内成功连接过 → 判在线
// 半开残留的死实例（旧身份 hostId）永远不会被本客户端连接，因此仍会被过滤。
export const RECENT_RELAY_HOST_CONNECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const RECENT_RELAY_HOST_CONNECTION_STORAGE_KEY = 'zterm:recentRelayHostConnections:v1';

export function readRecentRelayHostConnections(
  storage: BrowserStorageLike | null | undefined = getBrowserStorage(),
  now: number = Date.now(),
): Map<string, number> {
  const result = new Map<string, number>();
  if (!storage) {
    return result;
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(RECENT_RELAY_HOST_CONNECTION_STORAGE_KEY);
  } catch {
    return result;
  }
  if (!raw) {
    return result;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [hostId, timestamp] of Object.entries(parsed)) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        continue;
      }
      if (now - timestamp > RECENT_RELAY_HOST_CONNECTION_WINDOW_MS) {
        continue;
      }
      result.set(hostId, timestamp);
    }
  } catch {
    // 数据损坏时按空处理，不影响判活
  }
  return result;
}

export function rememberRelayHostConnection(
  daemonHostId: string,
  storage: BrowserStorageLike | null | undefined = getBrowserStorage(),
  now: number = Date.now(),
): void {
  const normalized = daemonHostId?.trim();
  if (!storage || !normalized) {
    return;
  }
  const connections = readRecentRelayHostConnections(storage, now);
  connections.set(normalized, now);
  try {
    storage.setItem(
      RECENT_RELAY_HOST_CONNECTION_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(connections)),
    );
  } catch {
    // 配额满 / 隐私模式写失败时静默——判活退化为仅依赖目录新鲜度
  }
}

export function isRelayHostRecentlyConnected(
  daemonHostId: string,
  storage: BrowserStorageLike | null | undefined = getBrowserStorage(),
  now: number = Date.now(),
): boolean {
  const normalized = daemonHostId?.trim();
  if (!normalized) {
    return false;
  }
  return readRecentRelayHostConnections(storage, now).has(normalized);
}
