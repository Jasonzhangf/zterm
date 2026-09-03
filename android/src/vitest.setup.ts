function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

const memoryStorage = createMemoryStorage();

if (typeof globalThis.WebSocket === 'undefined') {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: class WebSocketTestStub {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
    },
  });
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: memoryStorage,
});

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage,
  });
}
