import type { ReactNode } from 'react';
import { PluginCapabilityRegistry } from '@zterm/shared/terminal/plugin-capability-registry';
import { PluginUiSlotRegistry } from '@zterm/shared/terminal/plugin-ui-slot-registry';
import type {
  CapabilityId,
  PluginContext,
  PluginFactory,
  PluginInstance,
  PluginManifest,
  PluginState,
} from '@zterm/shared/terminal/plugin-contract';
import type { PluginUiSlot, PluginUiSlotId } from '@zterm/shared/terminal/plugin-ui-slot';

interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly instance: PluginInstance;
  state: PluginState;
  providedCapabilities: CapabilityId[];
  providedUiSlots: PluginUiSlotId[];
}

export interface PluginHost {
  provideCapability<T>(capabilityId: CapabilityId, value: T): void;
  provideUiSlot<TProps>(
    slotId: PluginUiSlotId,
    render: (props: Readonly<TProps>) => ReactNode,
  ): void;
  install(manifest: PluginManifest, factory: PluginFactory): void;
  start(pluginId: string): Promise<void>;
  startAll(): Promise<void>;
  stop(pluginId: string, reason: string): Promise<void>;
  disposeAll(reason: string): Promise<void>;
  readCapability<T>(capabilityId: CapabilityId): T;
  hasCapability(capabilityId: CapabilityId): boolean;
  readUiSlot<TProps>(slotId: PluginUiSlotId): PluginUiSlot<TProps>;
  hasUiSlot(slotId: PluginUiSlotId): boolean;
  getState(pluginId: string): PluginState | null;
  hasPlugin(pluginId: string): boolean;
  isDisposed(): boolean;
}

class PluginHostRuntime implements PluginHost {
  private readonly installed = new Map<string, InstalledPlugin>();
  private readonly capabilities = new PluginCapabilityRegistry();
  private readonly uiSlots = new PluginUiSlotRegistry();
  private disposed = false;

  provideCapability<T>(capabilityId: CapabilityId, value: T): void {
    this.requireActive();
    this.capabilities.registerProvider(capabilityId, value, false);
  }

  provideUiSlot<TProps>(
    slotId: PluginUiSlotId,
    render: (props: Readonly<TProps>) => ReactNode,
  ): void {
    this.requireActive();
    this.uiSlots.registerUiSlot(slotId, render, false);
  }

  install(manifest: PluginManifest, factory: PluginFactory): void {
    this.requireActive();
    if (this.installed.has(manifest.pluginId)) {
      throw new Error(`duplicate plugin: ${manifest.pluginId}`);
    }
    const missing = manifest.requires.filter((capabilityId) => !this.capabilities.has(capabilityId));
    if (missing.length > 0) {
      throw new Error(`plugin missing capabilities: ${missing.join(', ')}`);
    }
    const missingUiSlots = (manifest.requiresUiSlots ?? []).filter(
      (slotId) => !this.uiSlots.hasUiSlot(slotId),
    );
    if (missingUiSlots.length > 0) {
      throw new Error(`plugin missing ui slots: ${missingUiSlots.join(', ')}`);
    }
    for (const capabilityId of manifest.provides) {
      if (this.capabilities.has(capabilityId)) {
        throw new Error(`duplicate capability provider: ${capabilityId}`);
      }
    }
    for (const slotId of manifest.providesUiSlots ?? []) {
      if (this.uiSlots.hasUiSlot(slotId)) {
        throw new Error(`duplicate ui slot provider: ${slotId}`);
      }
    }
    this.installed.set(manifest.pluginId, {
      manifest,
      instance: factory.create(),
      state: 'installed',
      providedCapabilities: [],
      providedUiSlots: [],
    });
  }

  async start(pluginId: string): Promise<void> {
    this.requireActive();
    const record = this.requireInstalled(pluginId);
    if (record.state !== 'installed') {
      throw new Error(`plugin cannot start from state ${record.state}: ${pluginId}`);
    }

    const allowed = new Set([...record.manifest.requires, ...record.manifest.provides]);
    const context: PluginContext = {
      pluginId,
      readCapability: <T>(capabilityId: CapabilityId): T => {
        if (!allowed.has(capabilityId)) {
          throw new Error(`undeclared capability: ${capabilityId}`);
        }
        if (!this.capabilities.has(capabilityId)) {
          throw new Error(`unavailable capability: ${capabilityId}`);
        }
        return this.capabilities.resolve<T>(capabilityId);
      },
      provideCapability: <T>(capabilityId: CapabilityId, value: T): void => {
        if (!record.manifest.provides.includes(capabilityId)) {
          throw new Error(`undeclared provided capability: ${capabilityId}`);
        }
        if (this.capabilities.has(capabilityId)) {
          throw new Error(`duplicate capability provider: ${capabilityId}`);
        }
        this.capabilities.registerProvider(capabilityId, value, true);
        record.providedCapabilities.push(capabilityId);
      },
      readUiSlot: <TProps>(slotId: PluginUiSlotId): PluginUiSlot<TProps> => {
        if (!(record.manifest.requiresUiSlots ?? []).includes(slotId)) {
          throw new Error(`undeclared ui slot: ${slotId}`);
        }
        if (!this.uiSlots.hasUiSlot(slotId)) {
          throw new Error(`unavailable ui slot: ${slotId}`);
        }
        return this.uiSlots.resolveUiSlot<TProps>(slotId);
      },
      provideUiSlot: <TProps>(
        slotId: PluginUiSlotId,
        render: (props: Readonly<TProps>) => ReactNode,
      ): void => {
        if (!(record.manifest.providesUiSlots ?? []).includes(slotId)) {
          throw new Error(`undeclared provided ui slot: ${slotId}`);
        }
        if (this.uiSlots.hasUiSlot(slotId)) {
          throw new Error(`duplicate ui slot provider: ${slotId}`);
        }
        this.uiSlots.registerUiSlot(slotId, render, true);
        record.providedUiSlots.push(slotId);
      },
    };

    try {
      const result = record.instance.start(context);
      record.state = 'running';
      if (result && typeof (result as Promise<void>).then === 'function') {
        await (result as Promise<void>);
      }
    } catch (error) {
      record.state = 'installed';
      this.removePluginCapabilities(record);
      this.removePluginUiSlots(record);
      throw error;
    }
  }

  async startAll(): Promise<void> {
    for (const pluginId of this.installed.keys()) {
      await this.start(pluginId);
    }
  }

  async stop(pluginId: string, reason: string): Promise<void> {
    this.requireActive();
    const record = this.requireInstalled(pluginId);
    if (record.state !== 'running') {
      throw new Error(`plugin cannot stop from state ${record.state}: ${pluginId}`);
    }
    try {
      const result = record.instance.stop(reason);
      record.state = 'stopped';
      if (result && typeof (result as Promise<void>).then === 'function') {
        await (result as Promise<void>);
      }
    } catch (error) {
      record.state = 'running';
      throw error;
    }
    this.removePluginCapabilities(record);
    this.removePluginUiSlots(record);
  }

  async disposeAll(reason: string): Promise<void> {
    this.requireActive();
    for (const record of [...this.installed.values()]) {
      if (record.state === 'running') {
        await this.stop(record.manifest.pluginId, reason);
      }
      const result = record.instance.dispose();
      record.state = 'disposed';
      if (result && typeof (result as Promise<void>).then === 'function') {
        await (result as Promise<void>);
      }
    }
    this.disposed = true;
  }

  readCapability<T>(capabilityId: CapabilityId): T {
    this.requireActive();
    return this.capabilities.resolve<T>(capabilityId);
  }

  hasCapability(capabilityId: CapabilityId): boolean {
    this.requireActive();
    return this.capabilities.has(capabilityId);
  }

  readUiSlot<TProps>(slotId: PluginUiSlotId): PluginUiSlot<TProps> {
    this.requireActive();
    return this.uiSlots.resolveUiSlot<TProps>(slotId);
  }

  hasUiSlot(slotId: PluginUiSlotId): boolean {
    this.requireActive();
    return this.uiSlots.hasUiSlot(slotId);
  }

  getState(pluginId: string): PluginState | null {
    return this.installed.get(pluginId)?.state ?? null;
  }

  hasPlugin(pluginId: string): boolean {
    this.requireActive();
    return this.installed.has(pluginId);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private requireInstalled(pluginId: string): InstalledPlugin {
    const record = this.installed.get(pluginId);
    if (!record) {
      throw new Error(`unknown plugin: ${pluginId}`);
    }
    return record;
  }

  private removePluginCapabilities(record: InstalledPlugin): void {
    for (const capabilityId of record.providedCapabilities) {
      this.capabilities.removeProvider(capabilityId);
    }
    record.providedCapabilities = [];
  }

  private removePluginUiSlots(record: InstalledPlugin): void {
    for (const slotId of record.providedUiSlots) {
      this.uiSlots.removeUiSlot(slotId);
    }
    record.providedUiSlots = [];
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new Error('plugin host is disposed');
    }
  }
}

export function createPluginHost(): PluginHost {
  return new PluginHostRuntime();
}
