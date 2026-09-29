import type { WindowsTerminalTarget } from './windows-terminal-session';

export interface WindowsConnectionProfile {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
  sessionName: string;
}

export interface WindowsProfileStoreSnapshot {
  profiles: WindowsConnectionProfile[];
  activeProfileId: string | null;
}

export interface WindowsProfileStore {
  getSnapshot: () => WindowsProfileStoreSnapshot;
  subscribe: (listener: () => void) => () => void;
  saveProfile: (profile: Partial<WindowsConnectionProfile> & { name: string; bridgeHost: string; bridgePort: number; sessionName: string }) => WindowsConnectionProfile;
  deleteProfile: (profileId: string) => void;
  setActiveProfile: (profileId: string | null) => void;
  resolveTarget: (profile: WindowsConnectionProfile) => WindowsTerminalTarget;
}

const STORAGE_KEY = 'zterm:windows:profiles.v1';
const ACTIVE_KEY = 'zterm:windows:active-profile.v1';

function defaultProfile(name = 'local'): WindowsConnectionProfile {
  return {
    id: 'local',
    name,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'zterm',
  };
}

function isValidProfile(value: unknown): value is WindowsConnectionProfile {
  const profile = value as Partial<WindowsConnectionProfile>;
  return Boolean(
    typeof profile?.id === 'string'
    && typeof profile?.name === 'string'
    && typeof profile?.bridgeHost === 'string'
    && typeof profile?.bridgePort === 'number' && Number.isFinite(profile.bridgePort)
    && typeof profile?.sessionName === 'string',
  );
}

export function createWindowsProfileId() {
  return `profile-${crypto.randomUUID()}`;
}

export function normalizeWindowsProfile(input: Partial<WindowsConnectionProfile> & { name: string; bridgeHost: string; bridgePort: number; sessionName: string }): WindowsConnectionProfile {
  return {
    id: input.id || createWindowsProfileId(),
    name: input.name.trim() || 'local',
    bridgeHost: input.bridgeHost.trim(),
    bridgePort: input.bridgePort > 0 ? Math.floor(input.bridgePort) : 3333,
    authToken: input.authToken || undefined,
    sessionName: input.sessionName.trim(),
  };
}

export function createWindowsProfileStore(storage: Storage = window.localStorage): WindowsProfileStore {
  const listeners = new Set<() => void>();
  let snapshot: WindowsProfileStoreSnapshot = readStore(storage);

  const emit = () => listeners.forEach((listener) => listener());
  const write = (next: WindowsProfileStoreSnapshot) => {
    snapshot = next;
    storage.setItem(STORAGE_KEY, JSON.stringify(next.profiles));
    storage.setItem(ACTIVE_KEY, next.activeProfileId ?? '');
    emit();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    saveProfile(input) {
      const profile = normalizeWindowsProfile(input);
      const exists = snapshot.profiles.some((candidate) => candidate.id === profile.id);
      const profiles = exists
        ? snapshot.profiles.map((candidate) => (candidate.id === profile.id ? profile : candidate))
        : [...snapshot.profiles, profile];
      const activeProfileId = profile.id;
      write({ profiles, activeProfileId });
      return profile;
    },
    deleteProfile(profileId) {
      const profiles = snapshot.profiles.filter((profile) => profile.id !== profileId);
      if (profiles.length === 0) {
        const fallback = defaultProfile();
        write({ profiles: [fallback], activeProfileId: fallback.id });
        return;
      }
      const activeProfileId = snapshot.activeProfileId === profileId
        ? profiles[0]!.id
        : snapshot.activeProfileId;
      write({ profiles, activeProfileId });
    },
    setActiveProfile(profileId) {
      if (snapshot.profiles.some((profile) => profile.id === profileId)) {
        write({ ...snapshot, activeProfileId: profileId });
      }
    },
    resolveTarget(profile) {
      return {
        bridgeHost: profile.bridgeHost,
        bridgePort: profile.bridgePort,
        sessionName: profile.sessionName,
        authToken: profile.authToken,
      };
    },
  };
}

function readStore(storage: Storage): WindowsProfileStoreSnapshot {
  let profiles: WindowsConnectionProfile[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '[]') as unknown;
    if (Array.isArray(parsed)) {
      profiles = parsed.filter(isValidProfile);
    }
  } catch {
    profiles = [];
  }
  if (profiles.length === 0) {
    profiles = [defaultProfile()];
  }
  const storedActive = storage.getItem(ACTIVE_KEY) || '';
  const activeProfileId = profiles.some((profile) => profile.id === storedActive) ? storedActive : profiles[0]!.id;
  return { profiles, activeProfileId };
}
