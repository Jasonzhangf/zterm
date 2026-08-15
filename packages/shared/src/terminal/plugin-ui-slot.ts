import type { ReactNode } from 'react';

export type PluginUiSlotId = string;

export interface PluginUiSlot<TProps = unknown> {
  readonly slotId: PluginUiSlotId;
  render(props: Readonly<TProps>): ReactNode;
}

export interface PluginUiSlotProvider {
  registerUiSlot<TProps>(
    slotId: PluginUiSlotId,
    render: (props: Readonly<TProps>) => ReactNode,
    removable: boolean,
  ): void;
  resolveUiSlot<TProps>(slotId: PluginUiSlotId): PluginUiSlot<TProps>;
  hasUiSlot(slotId: PluginUiSlotId): boolean;
  removeUiSlot(slotId: PluginUiSlotId): void;
}
