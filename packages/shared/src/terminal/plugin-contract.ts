import type { ReactNode } from 'react';
import type { PluginUiSlot, PluginUiSlotId } from './plugin-ui-slot';

export type CapabilityId = string;

export interface CapabilityPort<T> {
  readonly capabilityId: CapabilityId;
  readonly value: T;
}

export interface PluginManifest {
  readonly pluginId: string;
  readonly version: string;
  readonly requires: readonly CapabilityId[];
  readonly provides: readonly CapabilityId[];
  readonly requiresUiSlots?: readonly PluginUiSlotId[];
  readonly providesUiSlots?: readonly PluginUiSlotId[];
}

export interface PluginContext {
  readonly pluginId: string;
  readCapability<T>(capabilityId: CapabilityId): T;
  provideCapability<T>(capabilityId: CapabilityId, value: T): void;
  readUiSlot<TProps>(slotId: PluginUiSlotId): PluginUiSlot<TProps>;
  provideUiSlot<TProps>(
    slotId: PluginUiSlotId,
    render: (props: Readonly<TProps>) => ReactNode,
  ): void;
}

export interface PluginInstance {
  start(context: PluginContext): void | Promise<void>;
  stop(reason: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface PluginFactory {
  create(): PluginInstance;
}

export type PluginState = 'installed' | 'running' | 'stopped' | 'disposed';

export interface PluginCapabilityProvider {
  registerProvider<T>(capabilityId: CapabilityId, value: T, removable: boolean): void;
  resolve<T>(capabilityId: CapabilityId): T;
  has(capabilityId: CapabilityId): boolean;
  removeProvider(capabilityId: CapabilityId): void;
}
