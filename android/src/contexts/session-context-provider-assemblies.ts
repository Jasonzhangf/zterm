import { useMemo } from 'react';
import type { SessionProviderAssembliesSharedOptions } from './session-context-provider-assembly-types';
import { useSessionProviderCoreAssemblies } from './session-context-provider-core-assemblies';
import { useSessionProviderFacadeAssemblies } from './session-context-provider-facade-assemblies';

export function useSessionProviderAssemblies(options: SessionProviderAssembliesSharedOptions) {
  const core = useSessionProviderCoreAssemblies(options);
  const facade = useSessionProviderFacadeAssemblies(options, core);

  return useMemo(() => ({
    getSessionRenderBufferSnapshot: core.getSessionRenderBufferSnapshot,
    getSessionBufferStore: core.getSessionBufferStore,
    getSessionRenderBufferStore: core.getSessionRenderBufferStore,
    getSessionHeadStore: core.getSessionHeadStore,
    ...facade,
  }), [core, facade]);
}
