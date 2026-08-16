import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(resolve(scriptDir, '..', 'contracts', 'app-version.json'), 'utf8'));

export function computeNormalVersionCode(buildNumber) {
  const versionCode = contract.version_code_epoch
    + (Number(buildNumber) * contract.normal_slot_stride);
  if (!Number.isSafeInteger(versionCode) || versionCode > contract.android_version_code_max) {
    throw new Error(`Android versionCode exceeds contract limit: ${versionCode}`);
  }
  return versionCode;
}

export function computeRollbackVersionCode(normalVersionCode) {
  const versionCode = Number(normalVersionCode) + contract.rollback_offset;
  if (!Number.isSafeInteger(versionCode) || versionCode > contract.android_version_code_max) {
    throw new Error(`Android rollback versionCode exceeds contract limit: ${versionCode}`);
  }
  return versionCode;
}

export function buildDisplayVersion(version, buildNumber, rollback = false) {
  return `${version}.${String(buildNumber).padStart(4, '0')}${rollback ? '.1' : ''}`;
}

export { contract as appVersionContract };
