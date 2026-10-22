import { describe, expect, it } from 'vitest';
import {
  CLI_SLOT_CONFIG_SCHEMA_VERSION,
  SlotConfigValidationError,
  normalizeSlotAlias,
  parseCloudSlotState,
  parseSyncedSlot,
  parseSyncedSlotBinding,
  parseSyncedSlots,
  projectSyncedSlot,
} from './cli-slot-config';

type BindingFixture = {
  alias?: string;
  server: {
    deviceId: string;
    daemonHostId: string;
    displayName: string;
  };
  session: {
    backend: 'tmux' | 'herdr';
    stableId: string;
    name: string;
  };
  widthMode: 'adaptive-phone' | 'mirror-fixed';
};

function makeBinding(): BindingFixture {
  return {
    alias: '  Build Machine  ',
    server: {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
      displayName: 'Mac Studio',
    },
    session: {
      backend: 'tmux',
      stableId: '$1',
      name: 'work',
    },
    widthMode: 'adaptive-phone',
  };
}

function captureValidationError(run: () => unknown): SlotConfigValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof SlotConfigValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a SlotConfigValidationError');
}

function expectValidationField(
  run: () => unknown,
  field: string,
): SlotConfigValidationError {
  const error = captureValidationError(run);
  expect(error.field).toBe(field);
  return error;
}

describe('CLI slot cloud contract', () => {
  it('publishes schema version 1', () => {
    expect(CLI_SLOT_CONFIG_SCHEMA_VERSION).toBe(1);
  });
});

describe('normalizeSlotAlias', () => {
  it('trims and preserves interior spaces and emoji', () => {
    expect(normalizeSlotAlias('  build 🚀 notes  ')).toBe('build 🚀 notes');
  });

  it('counts Unicode code points rather than UTF-16 units', () => {
    const accepted = '🚀'.repeat(80);
    expect(normalizeSlotAlias(accepted)).toBe(accepted);
    expectValidationField(
      () => normalizeSlotAlias('🚀'.repeat(81)),
      'alias',
    );
  });

  it('rejects empty and whitespace-only aliases', () => {
    expectValidationField(() => normalizeSlotAlias('   '), 'alias');
    expectValidationField(() => normalizeSlotAlias(' \t '), 'alias');
  });

  it('rejects C0, C1, and DEL controls', () => {
    for (const value of ['a\u0000b', 'a\u0085b', 'a\u007fb']) {
      expectValidationField(() => normalizeSlotAlias(value), 'alias');
    }
  });

  it('rejects line and paragraph separators', () => {
    expectValidationField(() => normalizeSlotAlias('a\u2028b'), 'alias');
    expectValidationField(() => normalizeSlotAlias('a\u2029b'), 'alias');
  });

  it('rejects bidi controls', () => {
    expectValidationField(() => normalizeSlotAlias('a\u202Eb'), 'alias');
    expectValidationField(() => normalizeSlotAlias('a\u2067b'), 'alias');
  });

  it('rejects non-string aliases', () => {
    expectValidationField(() => normalizeSlotAlias(42), 'alias');
  });
});

describe('parseSyncedSlotBinding', () => {
  it('returns a new validated binding and trims only the alias', () => {
    const input = makeBinding();
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = parseSyncedSlotBinding(input);

    expect(result).toEqual({
      alias: 'Build Machine',
      server: input.server,
      session: input.session,
      widthMode: input.widthMode,
    });
    expect(result).not.toBe(input);
    expect(result.server).not.toBe(input.server);
    expect(result.session).not.toBe(input.session);
    expect(input).toEqual(snapshot);
  });

  it('omits an absent alias instead of inventing one', () => {
    const input = makeBinding();
    delete input.alias;
    const result = parseSyncedSlotBinding(input);
    expect('alias' in result).toBe(false);
  });

  it('preserves opaque identity bytes without trimming', () => {
    const input = makeBinding();
    input.server.deviceId = '  device\u200D  ';
    input.server.daemonHostId = ' daemon ';
    input.session.stableId = ' tmux:$1 ';

    const result = parseSyncedSlotBinding(input);

    expect(result.server.deviceId).toBe(input.server.deviceId);
    expect(result.server.daemonHostId).toBe(input.server.daemonHostId);
    expect(result.session.stableId).toBe(input.session.stableId);
  });

  it('bounds opaque identity by UTF-8 bytes', () => {
    const accepted = makeBinding();
    accepted.server.deviceId = 'é'.repeat(512);
    expect(parseSyncedSlotBinding(accepted).server.deviceId).toBe(
      accepted.server.deviceId,
    );

    const rejected = makeBinding();
    rejected.server.deviceId = 'é'.repeat(513);
    expectValidationField(
      () => parseSyncedSlotBinding(rejected),
      'binding.server.deviceId',
    );
  });

  it('bounds display strings by Unicode code points', () => {
    const accepted = makeBinding();
    accepted.server.displayName = '🚀'.repeat(256);
    expect(parseSyncedSlotBinding(accepted).server.displayName).toBe(
      accepted.server.displayName,
    );

    const rejected = makeBinding();
    rejected.session.name = '🚀'.repeat(257);
    expectValidationField(
      () => parseSyncedSlotBinding(rejected),
      'binding.session.name',
    );
  });

  it('rejects terminal controls in display strings', () => {
    for (const value of ['\u001b', '\u009b', '\u007f', '\u2028', '\u202e']) {
      const input = makeBinding();
      input.server.displayName = `Mac${value}Studio`;
      expectValidationField(
        () => parseSyncedSlotBinding(input),
        'binding.server.displayName',
      );
    }
  });

  it('rejects empty display strings', () => {
    const input = makeBinding();
    input.session.name = '';
    expectValidationField(
      () => parseSyncedSlotBinding(input),
      'binding.session.name',
    );
  });

  it('rejects unknown top-level and nested fields', () => {
    const topLevel = { ...makeBinding(), account: { userId: 'user-1' } };
    expectValidationField(
      () => parseSyncedSlotBinding(topLevel),
      'binding.account',
    );

    const server = makeBinding();
    const serverInput = {
      ...server,
      server: { ...server.server, credential: 'secret' },
    };
    expectValidationField(
      () => parseSyncedSlotBinding(serverInput),
      'binding.server.credential',
    );

    const session = makeBinding();
    const sessionInput = {
      ...session,
      session: { ...session.session, endpoint: 'https://secret' },
    };
    expectValidationField(
      () => parseSyncedSlotBinding(sessionInput),
      'binding.session.endpoint',
    );
  });

  it('does not echo sensitive values in error messages', () => {
    const token = 'super-secret-token';
    const input = { ...makeBinding(), token };
    const error = expectValidationField(
      () => parseSyncedSlotBinding(input),
      'binding.token',
    );
    expect(error.message).not.toContain(token);
  });

  it('accepts only the existing backends and width modes', () => {
    const badBackend = makeBinding();
    badBackend.session.backend = 'zellij' as 'tmux';
    expectValidationField(
      () => parseSyncedSlotBinding(badBackend),
      'binding.session.backend',
    );

    const badWidth = makeBinding();
    badWidth.widthMode = 'fixed' as 'mirror-fixed';
    expectValidationField(
      () => parseSyncedSlotBinding(badWidth),
      'binding.widthMode',
    );
  });

  it('rejects non-object bindings', () => {
    for (const value of [null, [], 'binding', 1]) {
      expectValidationField(() => parseSyncedSlotBinding(value), 'binding');
    }
  });
});

describe('parseSyncedSlot', () => {
  it('parses the slot and returns a new cloud record', () => {
    const binding = makeBinding();
    const input = { slot: 20, ...binding };
    const result = parseSyncedSlot(input);

    expect(result).toEqual({ slot: 20, ...binding, alias: 'Build Machine' });
    expect(result).not.toBe(input);
    expect(result.server).not.toBe(input.server);
    expect(result.session).not.toBe(input.session);
    expect(input).toEqual({ slot: 20, ...binding });
  });

  it('requires an integer slot from 1 through 20', () => {
    for (const slot of [1, 20]) {
      expect(parseSyncedSlot({ slot, ...makeBinding() }).slot).toBe(slot);
    }
    for (const slot of [0, 21, 1.5, '1', Number.NaN]) {
      expectValidationField(
        () => parseSyncedSlot({ slot, ...makeBinding() }),
        'slot',
      );
    }
  });

  it('requires slot and rejects unknown top-level fields', () => {
    expectValidationField(() => parseSyncedSlot(makeBinding()), 'slot');
    expectValidationField(
      () => parseSyncedSlot({ slot: 1, ...makeBinding(), owner: 'user-1' }),
      'slot.owner',
    );
  });
});

describe('parseSyncedSlots', () => {
  it('returns a new ascending list without reordering the input', () => {
    const input = [
      { slot: 9, ...makeBinding() },
      { slot: 2, ...makeBinding() },
    ];
    const result = parseSyncedSlots(input);

    expect(result.map((slot) => slot.slot)).toEqual([2, 9]);
    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(input[1]);
    expect(input.map((slot) => slot.slot)).toEqual([9, 2]);
  });

  it('accepts an intentionally empty list', () => {
    expect(parseSyncedSlots([])).toEqual([]);
  });

  it('rejects duplicate slot numbers', () => {
    const input = [
      { slot: 4, ...makeBinding() },
      { slot: 4, ...makeBinding() },
    ];
    const error = expectValidationField(
      () => parseSyncedSlots(input),
      'slots[1]',
    );
    expect(error.message).toContain('duplicate');
  });

  it('rejects more than 20 records before applying duplicates', () => {
    const input = Array.from({ length: 21 }, (_, index) => ({
      slot: (index % 20) + 1,
      ...makeBinding(),
    }));
    const error = expectValidationField(
      () => parseSyncedSlots(input),
      'slots',
    );
    expect(error.message).toContain('at most 20');
  });

  it('rejects the whole payload when one record is invalid', () => {
    const input = [
      { slot: 1, ...makeBinding() },
      { slot: 2, ...makeBinding(), account: { userId: 'user-1' } },
    ];
    expectValidationField(() => parseSyncedSlots(input), 'slots[1].account');
  });

  it('rejects non-array input', () => {
    expectValidationField(() => parseSyncedSlots({ slots: [] }), 'slots');
  });
});

describe('parseCloudSlotState', () => {
  it('accepts a strict never-configured state', () => {
    const input = { configured: false };
    const result = parseCloudSlotState(input);
    expect(result).toEqual({ configured: false });
    expect(result).not.toBe(input);
  });

  it('rejects slots on a never-configured state', () => {
    expectValidationField(
      () => parseCloudSlotState({ configured: false, slots: [] }),
      'config.slots',
    );
  });

  it('accepts an intentionally empty configured state', () => {
    expect(parseCloudSlotState({ configured: true, slots: [] })).toEqual({
      configured: true,
      slots: [],
    });
  });

  it('parses configured records in ascending slot order', () => {
    const input = {
      configured: true,
      slots: [
        { slot: 8, ...makeBinding() },
        { slot: 3, ...makeBinding() },
      ],
    };
    const result = parseCloudSlotState(input);
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.slots.map((slot) => slot.slot)).toEqual([3, 8]);
    }
    expect(input.slots.map((slot) => slot.slot)).toEqual([8, 3]);
  });

  it('requires configured and a slots list when configured is true', () => {
    expectValidationField(
      () => parseCloudSlotState({ slots: [] }),
      'config.configured',
    );
    expectValidationField(
      () => parseCloudSlotState({ configured: true }),
      'config.slots',
    );
    expectValidationField(
      () => parseCloudSlotState({ configured: 'yes', slots: [] }),
      'config.configured',
    );
  });

  it('rejects unknown input and response fields', () => {
    for (const field of ['userId', 'owner', 'account', 'endpoint']) {
      expectValidationField(
        () => parseCloudSlotState({ configured: false, [field]: 'secret' }),
        `config.${field}`,
      );
    }
  });

  it('rejects nested secret fields in configured records', () => {
    expectValidationField(
      () =>
        parseCloudSlotState({
          configured: true,
          slots: [{ slot: 1, ...makeBinding(), credentials: 'secret' }],
        }),
      'config.slots[0].credentials',
    );
  });
});

describe('projectSyncedSlot', () => {
  it('copies only the explicit cloud whitelist from a local binding', () => {
    const localBinding = {
      alias: '  Work  ',
      account: {
        relayBaseUrl: 'https://relay.example',
        userId: 'user-1',
      },
      token: 'local-token',
      server: {
        deviceId: 'device-1',
        daemonHostId: 'daemon-1',
        displayName: 'Mac Studio',
        serverSecret: 'server-secret',
      },
      session: {
        backend: 'tmux',
        stableId: '$1',
        name: 'work',
        credentials: { password: 'password-secret' },
      },
      widthMode: 'mirror-fixed',
      slot: 99,
    };

    const result = projectSyncedSlot(3, localBinding);

    expect(result).toEqual({
      slot: 3,
      alias: 'Work',
      server: {
        deviceId: 'device-1',
        daemonHostId: 'daemon-1',
        displayName: 'Mac Studio',
      },
      session: {
        backend: 'tmux',
        stableId: '$1',
        name: 'work',
      },
      widthMode: 'mirror-fixed',
    });
    expect(Object.keys(result).sort()).toEqual(
      ['alias', 'server', 'session', 'slot', 'widthMode'].sort(),
    );
    expect(Object.keys(result.server).sort()).toEqual(
      ['daemonHostId', 'deviceId', 'displayName'].sort(),
    );
    expect(Object.keys(result.session).sort()).toEqual(
      ['backend', 'name', 'stableId'].sort(),
    );
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(localBinding.token).toBe('local-token');
  });

  it('uses the explicit slot argument rather than a local slot field', () => {
    const localBinding = { ...makeBinding(), slot: 99 };
    expect(projectSyncedSlot(4, localBinding).slot).toBe(4);
  });

  it('validates the projected binding', () => {
    const localBinding = { ...makeBinding(), widthMode: 'fixed' };
    expectValidationField(
      () => projectSyncedSlot(1, localBinding),
      'slot.widthMode',
    );
  });

  it('rejects non-object local bindings', () => {
    for (const value of [null, [], 'binding', 1]) {
      expectValidationField(() => projectSyncedSlot(1, value), 'binding');
    }
  });
});

describe('SlotConfigValidationError', () => {
  it('is a named error with an identifying field', () => {
    const error = new SlotConfigValidationError('binding.token', 'unknown field');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SlotConfigValidationError');
    expect(error.field).toBe('binding.token');
    expect(error.message).toContain('binding.token');
  });
});
