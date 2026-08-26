/**
 * iOS permission state contracts.
 * Owns: typed permission state projection from Capacitor Permissions plugin.
 * Forbidden: raw native objects, UI truth, domain state, terminal data stream.
 */
export type IosPermissionKind = 'camera' | 'microphone' | 'location' | 'notification';

export type IosPermissionState = 'granted' | 'denied' | 'prompt' | 'restricted';

export interface IosPermissionStatus {
  readonly kind: IosPermissionKind;
  readonly state: IosPermissionState;
}

export interface IosPermissionsBridge {
  check(permission: IosPermissionKind): Promise<IosPermissionState>;
  request(permission: IosPermissionKind): Promise<IosPermissionState>;
}

const PERMISSION_KINDS = new Set<IosPermissionKind>(['camera', 'microphone', 'location', 'notification']);

function isPermissionKind(value: unknown): value is IosPermissionKind {
  return typeof value === 'string' && PERMISSION_KINDS.has(value as IosPermissionKind);
}

function isPermissionState(value: unknown): value is IosPermissionState {
  return (
    value === 'granted' ||
    value === 'denied' ||
    value === 'prompt' ||
    value === 'restricted'
  );
}

export function validatePermissionKind(kind: unknown): IosPermissionKind {
  if (!isPermissionKind(kind)) throw new TypeError(`invalid permission kind: ${String(kind)}`);
  return kind;
}

export function validatePermissionState(state: unknown): IosPermissionState {
  if (!isPermissionState(state)) throw new TypeError(`invalid permission state: ${String(state)}`);
  return state;
}

/** Projects a native permission state to a typed permission status. */
export function projectPermissionStatus(
  kind: unknown,
  state: unknown,
): IosPermissionStatus {
  return {
    kind: validatePermissionKind(kind),
    state: validatePermissionState(state),
  };
}

/**
 * Creates a typed permissions manager over a Capacitor bridge.
 * All native state is validated before projection.
 */
export function createIosPermissionsManager(bridge: IosPermissionsBridge) {
  return {
    async check(kind: IosPermissionKind): Promise<IosPermissionStatus> {
      const state = await bridge.check(kind);
      return projectPermissionStatus(kind, state);
    },
    async request(kind: IosPermissionKind): Promise<IosPermissionStatus> {
      const state = await bridge.request(kind);
      return projectPermissionStatus(kind, state);
    },
    async checkAll(): Promise<readonly IosPermissionStatus[]> {
      const kinds: IosPermissionKind[] = ['camera', 'microphone', 'location', 'notification'];
      return Promise.all(kinds.map(async (kind) => this.check(kind)));
    },
  };
}
