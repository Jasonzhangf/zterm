import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ClientAction, UiPluginManifest } from '@zterm/ui-contract';
import { createReactSurfaceAdapter, type ProjectionSource } from './index.ts';

const manifest: UiPluginManifest = {
  pluginId: 'session-drawer',
  requires: ['capability:sessions'],
  contributes: [{ surfaceId: 'terminal.drawer', route: '/drawer', viewModelSchema: 'drawer@1' }],
};

interface DrawerModel {
  readonly open: boolean;
  readonly title: string;
}

type DrawerAction = ClientAction<{ source: 'test' }>;

function source(value: DrawerModel): ProjectionSource<DrawerModel> {
  return {
    getSnapshot: () => value,
    getServerSnapshot: () => value,
    subscribe: () => () => undefined,
  };
}

test('renders only the declared surface projection and emits typed actions', () => {
  const actions: DrawerAction[] = [];
  const Surface = createReactSurfaceAdapter<DrawerModel, DrawerAction>({
    manifest,
    surfaceId: 'terminal.drawer',
    projection: source({ open: true, title: 'Sessions' }),
    dispatch: (action) => actions.push(action),
    render: ({ viewModel, dispatch }) => createElement(
      'button',
      { onClick: () => dispatch({ type: 'drawer.close', payload: { source: 'test' } }) },
      viewModel.open ? viewModel.title : 'closed',
    ),
  });

  assert.equal(renderToStaticMarkup(createElement(Surface)), '<button>Sessions</button>');
  assert.deepEqual(actions, []);
});

test('rejects an undeclared surface instead of projecting another owner', () => {
  assert.throws(
    () => createReactSurfaceAdapter({
      manifest,
      surfaceId: 'terminal.quickbar',
      projection: source({ open: false, title: 'Quickbar' }),
      dispatch: () => undefined,
      render: () => null,
    }),
    /surface is not declared by manifest/,
  );
});

test('rejects control-shaped projection fields and malformed manifests', () => {
  assert.throws(
    () => createReactSurfaceAdapter({
      manifest: {
        ...manifest,
        contributes: [{ ...manifest.contributes[0], viewModelSchema: 'debug@1', route: '/drawer?retry=true' }],
      },
      surfaceId: 'terminal.drawer',
      projection: source({ open: true, title: 'Sessions' }),
      dispatch: () => undefined,
      render: () => null,
    }),
    /control fields cannot be encoded in view-model schema/,
  );
});
