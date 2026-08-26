import { KernelContractError, requireNonEmpty } from './errors.ts';

export type PluginState = 'installed' | 'running' | 'stopped' | 'disposed';

export interface PluginDefinition {
  readonly pluginId: string;
  readonly start: () => void | Promise<void>;
  readonly stop: (reason: string) => void | Promise<void>;
  readonly dispose: (reason: string) => void | Promise<void>;
}

interface PluginRecord {
  readonly definition: PluginDefinition;
  state: PluginState;
}

export class PluginLifecycle {
  private readonly plugins = new Map<string, PluginRecord>();

  install(definition: PluginDefinition): void {
    const pluginId = requireNonEmpty(definition.pluginId, 'pluginId');
    if (this.plugins.has(pluginId)) {
      throw new KernelContractError('duplicate_plugin', `duplicate plugin: ${pluginId}`);
    }
    this.plugins.set(pluginId, { definition, state: 'installed' });
  }

  state(pluginId: string): PluginState | null {
    return this.plugins.get(requireNonEmpty(pluginId, 'pluginId'))?.state ?? null;
  }

  async start(pluginId: string): Promise<void> {
    const record = this.requireRecord(pluginId);
    if (record.state !== 'installed') {
      throw new KernelContractError('invalid_plugin_transition', `plugin cannot start from state ${record.state}`);
    }
    try {
      await record.definition.start();
      record.state = 'running';
    } catch (error) {
      record.state = 'installed';
      throw error;
    }
  }

  async stop(pluginId: string, reason: string): Promise<void> {
    const record = this.requireRecord(pluginId);
    if (record.state !== 'running') {
      throw new KernelContractError('invalid_plugin_transition', `plugin cannot stop from state ${record.state}`);
    }
    await record.definition.stop(reason);
    record.state = 'stopped';
  }

  async dispose(pluginId: string, reason: string): Promise<void> {
    const record = this.requireRecord(pluginId);
    if (record.state === 'disposed') {
      throw new KernelContractError('invalid_plugin_transition', `plugin is already disposed: ${record.definition.pluginId}`);
    }
    let firstError: unknown;
    if (record.state === 'running') {
      try {
        await this.stop(pluginId, reason);
      } catch (error) {
        firstError = error;
      }
    }
    try {
      await record.definition.dispose(reason);
    } catch (error) {
      firstError ??= error;
    }
    record.state = 'disposed';
    if (firstError) throw firstError;
  }

  async disposeAll(reason: string): Promise<void> {
    let firstError: unknown;
    for (const pluginId of [...this.plugins.keys()].reverse()) {
      const record = this.plugins.get(pluginId);
      if (!record || record.state === 'disposed') continue;
      try {
        await this.dispose(pluginId, reason);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private requireRecord(pluginId: string): PluginRecord {
    const id = requireNonEmpty(pluginId, 'pluginId');
    const record = this.plugins.get(id);
    if (!record) {
      throw new KernelContractError('unknown_plugin', `unknown plugin: ${id}`);
    }
    return record;
  }
}
