export interface AppVersionContract {
  version_code_epoch: number;
  normal_slot_stride: number;
  rollback_offset: number;
  android_version_code_max: number;
}

export function computeNormalVersionCode(buildNumber: number): number;
export function computeRollbackVersionCode(normalVersionCode: number): number;
export function buildDisplayVersion(version: string, buildNumber: number, rollback?: boolean): string;
export const appVersionContract: AppVersionContract;
