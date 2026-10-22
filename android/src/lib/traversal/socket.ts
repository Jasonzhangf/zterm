import {
  TraversalSocket as SharedTraversalSocket,
  type TraversalSocketOptions,
} from '../../../../packages/shared/src/connection/traversal/socket';
import type {
  TraversalSettingsSource,
  TraversalTargetSource,
} from '../../../../packages/shared/src/connection/traversal/types';
import { createBrowserTraversalPlatform } from './browser-platform';
import { defaultTraversalRouteHealthCache } from './route-health-cache';

export type AndroidTraversalSocketOptions = Omit<
  Extract<TraversalSocketOptions, { candidateScope?: 'mode-default' }>,
  'platform' | 'candidateScope' | 'initialAttemptPort'
>;

export class TraversalSocket extends SharedTraversalSocket {
  public constructor(
    target: TraversalTargetSource,
    settings: TraversalSettingsSource,
    options: AndroidTraversalSocketOptions = {},
  ) {
    super(target, settings, {
      ...options,
      platform: createBrowserTraversalPlatform(),
      routeHealthCache: options.routeHealthCache ?? defaultTraversalRouteHealthCache,
    });
  }
}
