import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

export interface TraversalRelayUserRecord {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
}

export interface TraversalRelayTokenRecord {
  token: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface TraversalRelayStoreData {
  users: TraversalRelayUserRecord[];
  tokens: TraversalRelayTokenRecord[];
}

const EMPTY_STORE: TraversalRelayStoreData = {
  users: [],
  tokens: [],
};

function ensureStoreDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function stableNow() {
  return new Date().toISOString();
}

function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString('hex');
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

export class TraversalRelayStore {
  private data: TraversalRelayStoreData;

  public constructor(private readonly path: string) {
    this.data = this.load();
  }

  private load(): TraversalRelayStoreData {
    if (!existsSync(this.path)) {
      return { ...EMPTY_STORE };
    }
    const raw = readFileSync(this.path, 'utf-8');
    if (!raw.trim()) {
      return { ...EMPTY_STORE };
    }
    const parsed = JSON.parse(raw) as Partial<TraversalRelayStoreData>;
    return {
      users: Array.isArray(parsed.users) ? parsed.users as TraversalRelayUserRecord[] : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens as TraversalRelayTokenRecord[] : [],
    };
  }

  private persist() {
    ensureStoreDir(this.path);
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
    renameSync(tempPath, this.path);
  }

  public register(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      throw new Error('username is required');
    }
    if (!password.trim()) {
      throw new Error('password is required');
    }
    if (this.data.users.some((user) => user.username === normalizedUsername)) {
      throw new Error('username already exists');
    }
    const salt = randomHex(16);
    const now = stableNow();
    const record: TraversalRelayUserRecord = {
      id: randomHex(16),
      username: normalizedUsername,
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      createdAt: now,
    };
    this.data.users.push(record);
    this.persist();
    return {
      id: record.id,
      username: record.username,
      createdAt: record.createdAt,
    };
  }

  public login(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const user = this.data.users.find((entry) => entry.username === normalizedUsername);
    if (!user) {
      throw new Error('invalid username or password');
    }
    const expected = Buffer.from(user.passwordHash, 'hex');
    const actual = Buffer.from(hashPassword(password, user.passwordSalt), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('invalid username or password');
    }
    const now = stableNow();
    const tokenRecord: TraversalRelayTokenRecord = {
      token: randomHex(24),
      userId: user.id,
      createdAt: now,
      lastUsedAt: now,
    };
    this.data.tokens.push(tokenRecord);
    this.persist();
    return {
      token: tokenRecord.token,
      user: {
        id: user.id,
        username: user.username,
        createdAt: user.createdAt,
      },
    };
  }

  public authenticate(token: string) {
    const record = this.data.tokens.find((entry) => entry.token === token.trim());
    if (!record) {
      return null;
    }
    const user = this.data.users.find((entry) => entry.id === record.userId);
    if (!user) {
      return null;
    }
    record.lastUsedAt = stableNow();
    this.persist();
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
    };
  }

  public summary() {
    return {
      users: this.data.users.length,
      tokens: this.data.tokens.length,
    };
  }
}
