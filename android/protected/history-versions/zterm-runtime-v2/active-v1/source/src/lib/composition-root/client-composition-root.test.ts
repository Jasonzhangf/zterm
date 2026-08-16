import { describe, expect, it } from 'vitest';
import { ClientCompositionRoot } from './client-composition-root';

describe('client composition root', () => {
  it('binds and resolves declared runtime ports', () => {
    const root = new ClientCompositionRoot();
    root.bind({ portId: 'plugin-host', value: { pluginId: 'network-identity' } });

    expect(root.resolve<{ pluginId: string }>('plugin-host')).toEqual({
      pluginId: 'network-identity',
    });
    expect(root.has('plugin-host')).toBe(true);
  });

  it('rejects duplicate providers and unbound raw access', () => {
    const root = new ClientCompositionRoot();
    root.bind({ portId: 'plugin-host', value: 1 });

    expect(() => root.bind({ portId: 'plugin-host', value: 2 })).toThrow(
      /duplicate runtime port/,
    );
    expect(() => root.resolve('raw-socket')).toThrow(/unbound runtime port/);
    expect(root.has('raw-socket')).toBe(false);
  });

  it('fails activation when required composition ports are missing', () => {
    const root = new ClientCompositionRoot();
    root.bind({ portId: 'plugin-host', value: { audit: [] } });

    expect(() => root.require(['plugin-host', 'control-center'])).toThrow(
      /missing required runtime ports: control-center/,
    );
  });
});
