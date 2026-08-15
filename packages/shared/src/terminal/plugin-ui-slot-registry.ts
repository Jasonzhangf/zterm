import type { PluginUiSlot, PluginUiSlotId, PluginUiSlotProvider } from './plugin-ui-slot';

interface PluginUiSlotRecord {
  readonly slot: PluginUiSlot;
  readonly removable: boolean;
}

export class PluginUiSlotRegistry implements PluginUiSlotProvider {
  private readonly slots = new Map<PluginUiSlotId, PluginUiSlotRecord>();

  registerUiSlot<TProps>(
    slotId: PluginUiSlotId,
    render: (props: Readonly<TProps>) => unknown,
    removable: boolean,
  ): void {
    if (this.slots.has(slotId)) {
      throw new Error(`duplicate ui slot provider: ${slotId}`);
    }
    this.slots.set(slotId, {
      slot: {
        slotId,
        render: render as PluginUiSlot<TProps>['render'],
      },
      removable,
    });
  }

  resolveUiSlot<TProps>(slotId: PluginUiSlotId): PluginUiSlot<TProps> {
    const record = this.slots.get(slotId);
    if (!record) {
      throw new Error(`unavailable ui slot: ${slotId}`);
    }
    return record.slot as PluginUiSlot<TProps>;
  }

  hasUiSlot(slotId: PluginUiSlotId): boolean {
    return this.slots.has(slotId);
  }

  removeUiSlot(slotId: PluginUiSlotId): void {
    const record = this.slots.get(slotId);
    if (!record) {
      throw new Error(`unknown ui slot provider: ${slotId}`);
    }
    if (!record.removable) {
      throw new Error(`non-removable ui slot provider: ${slotId}`);
    }
    this.slots.delete(slotId);
  }
}
