import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import type {
  PluginContext,
  PluginFactory,
  PluginInstance,
  PluginManifest,
} from '@zterm/shared/terminal/plugin-contract';
import { PluginCapabilityRegistry } from '@zterm/shared/terminal/plugin-capability-registry';
import { FileTransferSheet } from '../../components/terminal/FileTransferSheet';
import { TerminalSessionDrawer } from '../../components/terminal/TerminalSessionDrawer';
import { AppUpdateSection } from '../../components/settings/AppUpdateSection';
import { RemoteWindowOverlay } from '../../components/terminal/RemoteWindowOverlay';
import { TerminalQuickBar } from '../../components/terminal/TerminalQuickBar';
import {
  SESSION_DRAWER_UI_SLOT_ID,
  type SessionDrawerUiProps,
} from '../plugin-session-drawer/session-drawer-contract';
import {
  FILE_BROWSER_UI_SLOT_ID,
  type FileBrowserUiProps,
} from '../plugin-file-browser/file-browser-contract';
import {
  SETTINGS_UPDATE_UI_SLOT_ID,
  type SettingsUpdateUiProps,
} from '../plugin-settings-update/settings-update-contract';
import {
  REMOTE_WINDOW_UI_SLOT_ID,
  type RemoteWindowUiProps,
} from '../plugin-remote-window/remote-window-contract';
import {
  QUICKBAR_UI_SLOT_ID,
  type QuickBarUiProps,
} from '../plugin-quickbar/quickbar-contract';
import {
  TERMINAL_SHELL_UI_SLOT_ID,
  type TerminalShellUiProps,
} from '../plugin-terminal-shell/terminal-shell-contract';
import { createPluginHost } from './plugin-host-runtime';
import { SessionDrawerUiPlugin } from './session-drawer-ui-plugin';
import { createFileTransferSessionRuntime } from '../file-transfer-session-runtime';
import { FileBrowserUiPlugin } from './file-browser-ui-plugin';
import { SettingsUpdateUiPlugin } from './settings-update-ui-plugin';
import { RemoteWindowUiPlugin } from './remote-window-ui-plugin';
import { QuickBarUiPlugin } from './quickbar-ui-plugin';
import { TerminalShellUiPlugin } from './terminal-shell-ui-plugin';

const manifest = (
  pluginId: string,
  requires: string[] = [],
  provides: string[] = [],
): PluginManifest => ({ pluginId, version: '1.0.0', requires, provides });

class RenderPlugin implements PluginInstance {
  seen: unknown;

  async start(context: PluginContext): Promise<void> {
    this.seen = context.readCapability('terminal:render');
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class UndeclaredPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.readCapability('raw:socket');
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class ProvidingPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    const value = context.readCapability('source:value');
    context.provideCapability('projected:value', value);
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class UndeclaredProvidePlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideCapability('undeclared:value', {});
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class UiSlotPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot('terminal.debug-console', () => 'debug-console-node');
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class UndeclaredUiSlotPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot('terminal.debug-console', () => 'debug-console-node');
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

function factoryOf(instance: PluginInstance): PluginFactory {
  return { create: () => instance };
}

describe('plugin host runtime', () => {
  it('rejects missing dependencies before creating the plugin instance', () => {
    const host = createPluginHost();
    let created = false;

    expect(() =>
      host.install(manifest('missing', ['terminal:render']), {
        create: () => {
          created = true;
          return new RenderPlugin();
        },
      }),
    ).toThrow(/missing capabilities/);
    expect(created).toBe(false);
  });

  it('injects only declared capabilities', async () => {
    const host = createPluginHost();
    host.provideCapability('terminal:render', { rows: [] });
    const plugin = new RenderPlugin();
    host.install(manifest('render', ['terminal:render']), factoryOf(plugin));

    await host.start('render');
    expect(plugin.seen).toEqual({ rows: [] });
    expect(host.getState('render')).toBe('running');
  });

  it('rejects undeclared raw access before activation', async () => {
    const host = createPluginHost();
    host.provideCapability('terminal:render', { rows: [] });
    host.install(manifest('bad', ['terminal:render']), factoryOf(new UndeclaredPlugin()));

    await expect(host.start('bad')).rejects.toThrow(/undeclared capability/);
    expect(host.getState('bad')).toBe('installed');
  });

  it('allows declared plugin-provided capabilities and removes them on stop', async () => {
    const host = createPluginHost();
    host.provideCapability('source:value', 'v1');
    host.install(
      manifest('provider', ['source:value'], ['projected:value']),
      factoryOf(new ProvidingPlugin()),
    );

    await host.start('provider');
    expect(host.readCapability('projected:value')).toBe('v1');

    await host.stop('provider', 'test');
    expect(host.hasCapability('projected:value')).toBe(false);
    expect(host.getState('provider')).toBe('stopped');
  });

  it('rejects providing a capability that is not declared in the manifest', async () => {
    const host = createPluginHost();
    host.provideCapability('source:value', 'v1');
    host.install(manifest('bad-provider'), factoryOf(new UndeclaredProvidePlugin()));

    await expect(host.start('bad-provider')).rejects.toThrow(/undeclared provided capability/);
  });

  it('runs deterministic lifecycle and rejects duplicate owners', async () => {
    const host = createPluginHost();
    host.provideCapability('terminal:render', { rows: [] });
    host.install(manifest('render', ['terminal:render']), factoryOf(new RenderPlugin()));

    expect(() =>
      host.install(manifest('render', ['terminal:render']), factoryOf(new RenderPlugin())),
    ).toThrow(/duplicate plugin/);
    expect(() => host.provideCapability('terminal:render', {})).toThrow(/duplicate capability/);

    await host.disposeAll('close');
    expect(host.getState('render')).toBe('disposed');
    expect(host.isDisposed()).toBe(true);
    await expect(host.disposeAll('again')).rejects.toThrow(/plugin host is disposed/);
  });

  it('allows composition to create a fresh host after disposal', async () => {
    const host = createPluginHost();
    host.provideCapability('terminal:render', { rows: [] });
    host.install(manifest('render', ['terminal:render']), factoryOf(new RenderPlugin()));
    await host.disposeAll('unmount');

    const replacement = createPluginHost();
    replacement.provideCapability('terminal:render', { rows: [] });
    expect(() => replacement.install(manifest('render', ['terminal:render']), factoryOf(new RenderPlugin()))).not.toThrow();
    await replacement.start('render');
    expect(replacement.getState('render')).toBe('running');
    await replacement.disposeAll('unmount');
    expect(replacement.isDisposed()).toBe(true);
  });

  it('registers declared plugin-provided ui slots and removes them on stop', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'debug-console',
        version: '1.0.0',
        requires: [],
        provides: [],
        providesUiSlots: ['terminal.debug-console'],
      },
      factoryOf(new UiSlotPlugin()),
    );

    await host.start('debug-console');
    expect(host.hasUiSlot('terminal.debug-console')).toBe(true);
    expect(host.readUiSlot('terminal.debug-console').render({})).toBe('debug-console-node');

    await host.stop('debug-console', 'test');
    expect(host.hasUiSlot('terminal.debug-console')).toBe(false);
  });

  it('rejects undeclared ui slot registration before activation', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'bad-slot',
        version: '1.0.0',
        requires: [],
        provides: [],
      },
      factoryOf(new UndeclaredUiSlotPlugin()),
    );

    await expect(host.start('bad-slot')).rejects.toThrow(/undeclared provided ui slot/);
    expect(host.hasUiSlot('terminal.debug-console')).toBe(false);
  });

  it('registers and removes the terminal.session-drawer slot through SessionDrawerUiPlugin', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'session-drawer',
        version: '1.0.0',
        requires: [],
        provides: [],
        providesUiSlots: [SESSION_DRAWER_UI_SLOT_ID],
      },
      { create: () => new SessionDrawerUiPlugin() },
    );

    await host.start('session-drawer');
    expect(host.hasUiSlot(SESSION_DRAWER_UI_SLOT_ID)).toBe(true);
    const slot = host.readUiSlot<SessionDrawerUiProps>(SESSION_DRAWER_UI_SLOT_ID);
    const element = slot.render({
      open: false,
      sessions: [],
      onClose: () => undefined,
      onSelectSession: () => undefined,
      onCloseSession: () => undefined,
      onOpenQuickTabPicker: () => undefined,
    });
    expect(isValidElement(element)).toBe(true);
    expect((element as ReactElement).type).toBe(TerminalSessionDrawer);

    await host.stop('session-drawer', 'test');
    expect(host.hasUiSlot(SESSION_DRAWER_UI_SLOT_ID)).toBe(false);
  });

  it('registers and removes the terminal.file-browser slot through FileBrowserUiPlugin', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'file-browser',
        version: '1.0.0',
        requires: [],
        provides: [],
        providesUiSlots: [FILE_BROWSER_UI_SLOT_ID],
      },
      { create: () => new FileBrowserUiPlugin() },
    );

    await host.start('file-browser');
    expect(host.hasUiSlot(FILE_BROWSER_UI_SLOT_ID)).toBe(true);
    const slot = host.readUiSlot<FileBrowserUiProps>(FILE_BROWSER_UI_SLOT_ID);
    const element = slot.render({
      open: false,
      remoteCwd: '',
      onClose: () => undefined,
      fileTransferRuntime: createFileTransferSessionRuntime(),
      onFileTransferStateChange: () => () => undefined,
    });
    expect(isValidElement(element)).toBe(true);
    expect((element as ReactElement).type).toBe(FileTransferSheet);

    await host.stop('file-browser', 'test');
    expect(host.hasUiSlot(FILE_BROWSER_UI_SLOT_ID)).toBe(false);
  });

  it('registers and removes the settings.update slot through SettingsUpdateUiPlugin', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'settings-update',
        version: '1.0.0',
        requires: [],
        provides: [],
        providesUiSlots: [SETTINGS_UPDATE_UI_SLOT_ID],
      },
      { create: () => new SettingsUpdateUiPlugin() },
    );

    await host.start('settings-update');
    expect(host.hasUiSlot(SETTINGS_UPDATE_UI_SLOT_ID)).toBe(true);
    const slot = host.readUiSlot<SettingsUpdateUiProps>(SETTINGS_UPDATE_UI_SLOT_ID);
    const element = slot.render({
      currentVersionName: '0.1.1.1590',
      currentVersionCode: 1011590,
      updateDraft: {
        manifestUrl: '',
        autoCheckOnLaunch: false,
        skippedVersionCode: undefined,
        ignoreUntilManualCheck: false,
        lastCheckedAt: undefined,
        lastSeenVersionCode: undefined,
      },
      latestManifest: null,
      updateChecking: false,
      updateInstalling: false,
      updateError: null,
      hasNewVersion: false,
      hasUpdateIgnorePolicy: false,
      onUpdateDraftChange: () => undefined,
      onCheckForUpdate: () => undefined,
      onInstallUpdate: () => undefined,
      onResetUpdateIgnorePolicy: () => undefined,
      rollbackBackup: null,
      isRollingBack: false,
      onRollback: () => undefined,
    });
    expect(isValidElement(element)).toBe(true);
    expect((element as ReactElement).type).toBe(AppUpdateSection);

    await host.stop('settings-update', 'test');
    expect(host.hasUiSlot(SETTINGS_UPDATE_UI_SLOT_ID)).toBe(false);
  });

  it('registers and removes the terminal.remote-window slot through RemoteWindowUiPlugin', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'remote-window',
        version: '1.0.0',
        requires: [],
        provides: [],
        providesUiSlots: [REMOTE_WINDOW_UI_SLOT_ID],
      },
      { create: () => new RemoteWindowUiPlugin() },
    );

    await host.start('remote-window');
    expect(host.hasUiSlot(REMOTE_WINDOW_UI_SLOT_ID)).toBe(true);
    const slot = host.readUiSlot<RemoteWindowUiProps>(REMOTE_WINDOW_UI_SLOT_ID);
    const element = slot.render({} as RemoteWindowUiProps);
    expect(isValidElement(element)).toBe(true);
    expect((element as ReactElement).type).toBe(RemoteWindowOverlay);

    await host.stop('remote-window', 'test');
    expect(host.hasUiSlot(REMOTE_WINDOW_UI_SLOT_ID)).toBe(false);
  });

  it('registers and removes the terminal.quickbar slot through QuickBarUiPlugin', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'quickbar',
        version: '1.0.0',
        requires: [],
        provides: [],
        providesUiSlots: [QUICKBAR_UI_SLOT_ID],
      },
      { create: () => new QuickBarUiPlugin() },
    );

    await host.start('quickbar');
    expect(host.hasUiSlot(QUICKBAR_UI_SLOT_ID)).toBe(true);
    const slot = host.readUiSlot<QuickBarUiProps>(QUICKBAR_UI_SLOT_ID);
    const element = slot.render({
      quickActions: [],
      shortcutActions: [],
      sessionDraft: '',
    });
    expect(isValidElement(element)).toBe(true);
    expect((element as ReactElement).type).toBe(TerminalQuickBar);

    await host.stop('quickbar', 'test');
    expect(host.hasUiSlot(QUICKBAR_UI_SLOT_ID)).toBe(false);
  });

  it('registers and removes the terminal.shell slot through TerminalShellUiPlugin', async () => {
    const host = createPluginHost();
    host.install(
      {
        pluginId: 'terminal-shell',
        version: '1.0.0',
        requires: [],
        provides: [],
        providesUiSlots: [TERMINAL_SHELL_UI_SLOT_ID],
      },
      { create: () => new TerminalShellUiPlugin() },
    );

    await host.start('terminal-shell');
    expect(host.hasUiSlot(TERMINAL_SHELL_UI_SLOT_ID)).toBe(true);
    const slot = host.readUiSlot<TerminalShellUiProps>(TERMINAL_SHELL_UI_SLOT_ID);
    const element = slot.render({
      networkBanner: {
        connectionIssueVisible: false,
        activeSessionState: 'connected',
      },
      topProjection: {
        statusStrip: null,
        controls: null,
      },
      stage: {} as TerminalShellUiProps['stage'],
      copyMenu: null,
      bottomProjection: null,
      quickBarShell: {
        visible: false,
        bottomPx: 0,
        zIndex: 10,
        centered: false,
        children: null,
      },
    });
    expect(isValidElement(element)).toBe(true);

    await host.stop('terminal-shell', 'test');
    expect(host.hasUiSlot(TERMINAL_SHELL_UI_SLOT_ID)).toBe(false);
  });

  it('rejects missing and duplicate ui slot providers before activation', () => {
    const host = createPluginHost();

    expect(() =>
      host.install(
        {
          pluginId: 'missing-slot',
          version: '1.0.0',
          requires: [],
          provides: [],
          requiresUiSlots: ['terminal.surface'],
        },
        factoryOf(new UiSlotPlugin()),
      ),
    ).toThrow(/missing ui slots/);

    host.provideUiSlot('terminal.surface', () => 'surface-node');
    expect(() =>
      host.install(
        {
          pluginId: 'debug-console',
          version: '1.0.0',
          requires: [],
          provides: [],
          providesUiSlots: ['terminal.surface'],
        },
        factoryOf(new UiSlotPlugin()),
      ),
    ).toThrow(/duplicate ui slot provider/);
    expect(() =>
      host.install(
        {
          pluginId: 'second-slot',
          version: '1.0.0',
          requires: [],
          provides: [],
          providesUiSlots: ['terminal.surface'],
        },
        factoryOf(new UiSlotPlugin()),
      ),
    ).toThrow(/duplicate ui slot provider/);
  });
});

describe('plugin capability registry', () => {
  it('enforces unique providers and removable lifecycle', () => {
    const registry = new PluginCapabilityRegistry();
    registry.registerProvider('terminal:render', { rows: [] }, false);

    expect(() => registry.registerProvider('terminal:render', {}, true)).toThrow(
      /duplicate capability provider/,
    );
    expect(() => registry.removeProvider('terminal:render')).toThrow(/non-removable/);

    registry.registerProvider('terminal:preview', {}, true);
    registry.removeProvider('terminal:preview');
    expect(registry.has('terminal:preview')).toBe(false);
  });
});
