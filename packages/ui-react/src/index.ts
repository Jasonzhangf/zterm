import { useSyncExternalStore, type ReactElement } from 'react';
import type { ClientAction, UiPluginManifest } from '@zterm/ui-contract';

export interface ProjectionSource<TViewModel> {
  readonly getSnapshot: () => TViewModel;
  readonly getServerSnapshot: () => TViewModel;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface ReactSurfaceRenderContext<TViewModel, TAction extends ClientAction> {
  readonly viewModel: Readonly<TViewModel>;
  readonly dispatch: (action: TAction) => void;
}

export interface ReactSurfaceAdapterOptions<TViewModel, TAction extends ClientAction> {
  readonly manifest: UiPluginManifest;
  readonly surfaceId: string;
  readonly projection: ProjectionSource<TViewModel>;
  readonly dispatch: (action: TAction) => void;
  readonly render: (context: ReactSurfaceRenderContext<TViewModel, TAction>) => ReactElement | null;
}

export function createReactSurfaceAdapter<TViewModel, TAction extends ClientAction>(
  options: ReactSurfaceAdapterOptions<TViewModel, TAction>,
): () => ReactElement | null {
  const contribution = options.manifest.contributes.find(
    (entry) => entry.surfaceId === options.surfaceId,
  );
  if (!contribution) {
    throw new Error(`surface is not declared by manifest: ${options.surfaceId}`);
  }
  if (/[?&#]|\b(?:retry|control|provider|debug|scope|stop)\b/i.test(contribution.route)) {
    throw new Error('control fields cannot be encoded in view-model schema');
  }
  if (/\b(?:retry|control|provider|debug|scope|stop)\b/i.test(contribution.viewModelSchema)) {
    throw new Error('control fields cannot be encoded in view-model schema');
  }

  return function ReactSurfaceAdapter(): ReactElement | null {
    const viewModel = useSyncExternalStore(
      options.projection.subscribe,
      options.projection.getSnapshot,
      options.projection.getServerSnapshot,
    );
    return options.render({ viewModel, dispatch: options.dispatch });
  };
}
