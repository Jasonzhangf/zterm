export type IosPermissionKind = 'camera' | 'microphone' | 'location' | 'notification';
export type IosPermissionState = 'granted' | 'denied' | 'prompt' | 'restricted';
export interface IosPermissionStatus { readonly kind: IosPermissionKind; readonly state: IosPermissionState }
export interface IosPermissionsBridge { check(permission: IosPermissionKind): Promise<IosPermissionState>; request(permission: IosPermissionKind): Promise<IosPermissionState> }
const KINDS = new Set<IosPermissionKind>(['camera', 'microphone', 'location', 'notification']);
const STATES = new Set<IosPermissionState>(['granted', 'denied', 'prompt', 'restricted']);
export function validatePermissionKind(kind: unknown): IosPermissionKind {
  if (typeof kind !== 'string' || !KINDS.has(kind as IosPermissionKind)) throw new TypeError(`invalid permission kind: ${String(kind)}`);
  return kind as IosPermissionKind;
}
export function validatePermissionState(state: unknown): IosPermissionState {
  if (typeof state !== 'string' || !STATES.has(state as IosPermissionState)) throw new TypeError(`invalid permission state: ${String(state)}`);
  return state as IosPermissionState;
}
export function projectPermissionStatus(kind: unknown, state: unknown): IosPermissionStatus {
  return { kind: validatePermissionKind(kind), state: validatePermissionState(state) };
}
export function createIosPermissionsManager(bridge: IosPermissionsBridge) {
  return {
    check: async (kind: IosPermissionKind) => projectPermissionStatus(kind, await bridge.check(kind)),
    request: async (kind: IosPermissionKind) => projectPermissionStatus(kind, await bridge.request(kind)),
    checkAll: async () => Promise.all((['camera', 'microphone', 'location', 'notification'] as IosPermissionKind[]).map(async (kind) => projectPermissionStatus(kind, await bridge.check(kind)))),
  };
}
