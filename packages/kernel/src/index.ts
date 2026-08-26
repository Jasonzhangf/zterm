export { KernelContractError } from './errors.ts';
import { CapabilityRegistry } from './capability-registry.ts';
import { CompositionRoot } from './composition-root.ts';
import { ControlCenter } from './control-center.ts';
import { ObservabilityHub } from './observability-hub.ts';
import { PluginLifecycle } from './plugin-lifecycle.ts';
import { ProjectionRegistry } from './projection-registry.ts';

export { CompositionRoot } from './composition-root.ts';
export type { DisposableService } from './composition-root.ts';
export { CapabilityRegistry } from './capability-registry.ts';
export { ControlCenter } from './control-center.ts';
export type { ControlAuditEntry, ControlCenterOptions, ControlExecutionRequest } from './control-center.ts';
export { PluginLifecycle } from './plugin-lifecycle.ts';
export type { PluginDefinition, PluginState } from './plugin-lifecycle.ts';
export { ProjectionRegistry } from './projection-registry.ts';
export type { ProjectionSnapshot } from './projection-registry.ts';
export { ObservabilityHub } from './observability-hub.ts';
export type { ObservabilityRecord } from './observability-hub.ts';

export function createKernel(): {
  readonly composition: import('./composition-root.ts').CompositionRoot;
  readonly capabilities: import('./capability-registry.ts').CapabilityRegistry;
  readonly control: import('./control-center.ts').ControlCenter;
  readonly plugins: import('./plugin-lifecycle.ts').PluginLifecycle;
  readonly projections: import('./projection-registry.ts').ProjectionRegistry<unknown>;
  readonly observability: import('./observability-hub.ts').ObservabilityHub;
} {
  return {
    composition: new CompositionRoot(),
    capabilities: new CapabilityRegistry(),
    control: new ControlCenter(),
    plugins: new PluginLifecycle(),
    projections: new ProjectionRegistry(),
    observability: new ObservabilityHub(),
  };
}
