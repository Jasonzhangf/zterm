import type { TraversalRelayDeviceSnapshot } from './types';
import { readTraversalRelayAccountState, type TraversalRelayAccountState } from './traversal-relay-client';
import {
  dedupeRelayDaemonDeviceSnapshots,
  projectRelayDirectoryDeviceSnapshots,
} from './relay-account-directory';
import { readRecentRelayHostConnections } from './relay-host-recent-connection';
import { getBrowserStorage } from './browser-storage';

export function countConnectedTraversalRelayDevices(devices: TraversalRelayDeviceSnapshot[]) {
  return devices.filter((device) => device.daemon.connected || device.client.connected).length;
}

// 服务端目录 lastSeenAt 随 daemon 的 directory-update 定期 publish 刷新；
// 超过该阈值未刷新视为半开残留（网络变化/进程死亡后服务端连接残留），不再判在线。
// 阈值取 publish 间隔（60s）的 15 倍，容忍心跳抖动与客户端时钟偏移。
export const ONLINE_DAEMON_FRESHNESS_MS = 15 * 60_000;

export function isOnlineTraversalRelayDaemonDevice(
  device: TraversalRelayDeviceSnapshot,
  now: number = Date.now(),
  recentConnections?: ReadonlyMap<string, number>,
) {
  if (!device.daemon.connected || device.daemon.hostId.trim().length === 0) {
    return false;
  }
  const lastSeenAt = Date.parse(device.daemon.lastSeenAt || '');
  if (!Number.isFinite(lastSeenAt)) {
    // 无 lastSeenAt 时保守放行（服务端老记录不判死），避免误杀
    return true;
  }
  if (now - lastSeenAt <= ONLINE_DAEMON_FRESHNESS_MS) {
    return true;
  }
  // 陈旧但本客户端最近成功连接过 → 仍判在线。覆盖未升级 daemon（无定期 publish，
  // lastSeenAt 停在启动时刻）与长睡眠恢复场景；半开残留的死实例从未被连接，仍被过滤。
  return Boolean(recentConnections?.has(device.daemon.hostId.trim()));
}

export function listOnlineTraversalRelayDaemonDevices(
  devices: TraversalRelayDeviceSnapshot[],
  now: number = Date.now(),
  recentConnections?: ReadonlyMap<string, number>,
) {
  // 用箭头函数包裹，避免 filter 把 index 传入 isOnline 的 now 参数
  const recent = recentConnections ?? readRecentRelayHostConnections(getBrowserStorage(), now);
  return devices.filter((device) => isOnlineTraversalRelayDaemonDevice(device, now, recent));
}

export function projectOnlineTraversalRelayDaemonDevicesFromAccount(
  account: TraversalRelayAccountState | null | undefined,
  now: number = Date.now(),
  recentConnections?: ReadonlyMap<string, number>,
) {
  if (!account) {
    return [];
  }
  const recent = recentConnections ?? readRecentRelayHostConnections(getBrowserStorage(), now);
  const directoryDevices = projectRelayDirectoryDeviceSnapshots(account.directory);
  const accountDevices = account.devices || [];
  if (directoryDevices.length === 0) {
    return listOnlineTraversalRelayDaemonDevices(dedupeRelayDaemonDeviceSnapshots(accountDevices), now, recent);
  }

  // `/api/auth/me` and the live directory stream carry the same control-plane
  // resource, but older clients can persist a partial directory containing
  // client-only rows. Preserve an online daemon row from the account snapshot
  // only when the directory has no daemon identity for that device. A directory
  // row that explicitly identifies a daemon remains authoritative, including
  // its disconnected state.
  const directoryByDeviceId = new Map(directoryDevices.map((device) => [device.deviceId, device]));
  const merged = [...directoryDevices];
  for (const accountDevice of accountDevices) {
    if (!isOnlineTraversalRelayDaemonDevice(accountDevice, now, recent)) {
      continue;
    }
    const directoryDevice = directoryByDeviceId.get(accountDevice.deviceId);
    if (directoryDevice?.daemon.hostId.trim()) {
      continue;
    }
    if (!directoryDevice) {
      merged.push(accountDevice);
      continue;
    }
    const index = merged.indexOf(directoryDevice);
    if (index >= 0) {
      merged[index] = accountDevice;
    }
  }
  return listOnlineTraversalRelayDaemonDevices(dedupeRelayDaemonDeviceSnapshots(merged), now, recent);
}

export function readOnlineTraversalRelayDaemonDevices() {
  const account = readTraversalRelayAccountState();
  return projectOnlineTraversalRelayDaemonDevicesFromAccount(account);
}
