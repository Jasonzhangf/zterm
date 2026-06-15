import { useState, useCallback } from 'react';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { getBrowserStorage } from '../lib/browser-storage';
import { APP_VERSION } from '../lib/app-version';
import {
  buildConfigExportPayload,
  validateConfigExportPayload,
  applyConfigImportPayload,
} from '../lib/config-export';

const CONFIG_EXPORT_DIR = 'zterm-config-export';
const CONFIG_EXPORT_FILE = 'zterm-config.json';

export function useConfigExport() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const exportConfig = useCallback(async () => {
    setExporting(true);
    setLastError(null);
    try {
      const storage = getBrowserStorage();
      if (!storage) {
        throw new Error('Storage not available');
      }
      const payload = buildConfigExportPayload({
        storage,
        exportedAt: Date.now(),
        appVersion: APP_VERSION,
      });
      const json = JSON.stringify(payload, null, 2);
      await Filesystem.mkdir({
        path: CONFIG_EXPORT_DIR,
        directory: Directory.ExternalStorage,
        recursive: true,
      });
      const result = await Filesystem.writeFile({
        path: `${CONFIG_EXPORT_DIR}/${CONFIG_EXPORT_FILE}`,
        data: json,
        directory: Directory.ExternalStorage,
      });
      console.log('[ConfigExport] Config exported to:', result.uri);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed';
      setLastError(message);
      return false;
    } finally {
      setExporting(false);
    }
  }, []);

  const importConfig = useCallback(async () => {
    setImporting(true);
    setLastError(null);
    try {
      const storage = getBrowserStorage();
      if (!storage) {
        throw new Error('Storage not available');
      }
      const result = await Filesystem.readFile({
        path: `${CONFIG_EXPORT_DIR}/${CONFIG_EXPORT_FILE}`,
        directory: Directory.ExternalStorage,
      });
      const json = typeof result.data === 'string' ? result.data : '';
      const payload: unknown = JSON.parse(json);
      const validated = validateConfigExportPayload(payload);
      if (!validated) {
        throw new Error('Invalid config file format');
      }
      applyConfigImportPayload(storage, validated);
      globalThis.location?.reload();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed';
      setLastError(message);
      return false;
    } finally {
      setImporting(false);
    }
  }, []);

  return {
    exporting,
    importing,
    lastError,
    exportConfig,
    importConfig,
  };
}
