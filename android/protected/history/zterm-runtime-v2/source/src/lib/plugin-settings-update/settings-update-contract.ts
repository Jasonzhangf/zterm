import type { ReactNode } from 'react';
import type { AppUpdateSectionProps } from '../../components/settings/AppUpdateSection';

export const SETTINGS_UPDATE_UI_SLOT_ID = 'settings.update' as const;

export type SettingsUpdateUiProps = AppUpdateSectionProps;

export interface SettingsUpdateUiSlot {
  readonly slotId: typeof SETTINGS_UPDATE_UI_SLOT_ID;
  render(props: SettingsUpdateUiProps): ReactNode;
}

export type { AppUpdateManifestCandidate } from '../../components/settings/AppUpdateSection';
