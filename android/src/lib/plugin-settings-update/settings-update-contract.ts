import type { ReactNode } from 'react';
import type {
  AppUpdateManifest,
  AppUpdateManifestCandidate,
  AppUpdatePreferences,
  AppUpdateRollbackBackup,
  AppUpdateRollbackEntry,
} from '../app-update';

export const SETTINGS_UPDATE_UI_SLOT_ID = 'settings.update' as const;

export type { AppUpdateManifestCandidate };

export interface SettingsUpdateUiProps {
  currentVersionName: string;
  currentVersionCode: number;
  updateDraft: AppUpdatePreferences;
  latestManifest: AppUpdateManifest | null;
  updateChecking: boolean;
  updateInstalling: boolean;
  updateError: string | null;
  hasNewVersion: boolean;
  hasUpdateIgnorePolicy: boolean;
  manifestCandidates?: AppUpdateManifestCandidate[];
  onUpdateDraftChange: (updater: (current: AppUpdatePreferences) => AppUpdatePreferences) => void;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  onResetUpdateIgnorePolicy: () => void;
  onExportConfig?: () => void;
  onImportConfig?: () => void;
  configExporting?: boolean;
  configImporting?: boolean;
  rollbackBackup?: AppUpdateRollbackBackup | null;
  isRollingBack?: boolean;
  onRollback?: () => void;
  rollbackToPreviousEntry?: AppUpdateRollbackEntry | null;
  onRollbackToPrevious?: () => void;
}

export interface SettingsUpdateUiSlot {
  readonly slotId: typeof SETTINGS_UPDATE_UI_SLOT_ID;
  render(props: SettingsUpdateUiProps): ReactNode;
}
