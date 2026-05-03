import type { SessionProviderAssembliesSharedOptions } from './session-context-provider-assembly-types';
import { useSessionProviderCoreAssemblies } from './session-context-provider-core-assemblies';
import { useSessionProviderFacadeAssemblies } from './session-context-provider-facade-assemblies';

export function useSessionProviderAssemblies(options: SessionProviderAssembliesSharedOptions) {
  const core = useSessionProviderCoreAssemblies(options);
  const facade = useSessionProviderFacadeAssemblies(options, core);

  return {
    getSessionRenderBufferSnapshot: core.getSessionRenderBufferSnapshot,
    getSessionBufferStore: core.getSessionBufferStore,
    getSessionHeadStore: core.getSessionHeadStore,
    ...facade,
  };
}
