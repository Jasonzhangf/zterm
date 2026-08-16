import { describe, expect, it } from 'vitest';
import {
  appVersionContract,
  buildDisplayVersion,
  computeNormalVersionCode,
  computeRollbackVersionCode,
} from './app-version.mjs';

function computeShippedLegacyVersionCode(version: string, buildNumber: number) {
  const semver = version.split('.').map((part) => Number.parseInt(part.match(/^\d+/)?.[0] || '0', 10));
  while (semver.length < 3) {
    semver.push(0);
  }
  return (semver[0]! * 100000000) + (semver[1]! * 1000000) + (semver[2]! * 10000) + buildNumber;
}

describe('app update version slots', () => {
  it('orders normal N before rollback N.1 before normal N+1', () => {
    const normal = computeNormalVersionCode(2280);
    const rollback = computeRollbackVersionCode(normal);
    const nextNormal = computeNormalVersionCode(2281);

    expect(normal).toBeLessThan(rollback);
    expect(rollback).toBeLessThan(nextNormal);
    expect(buildDisplayVersion('0.1.3', 2280)).toBe('0.1.3.2280');
    expect(buildDisplayVersion('0.1.3', 2280, true)).toBe('0.1.3.2280.1');
  });

  it('migrates above the shipped bit-30 rollback namespace', () => {
    const oldRollbackCode = (2 ** 30) + computeShippedLegacyVersionCode('0.1.3', 2279);
    expect(computeNormalVersionCode(2280)).toBeGreaterThan(oldRollbackCode);
  });

  it('stays within the Android versionCode limit', () => {
    expect(computeRollbackVersionCode(computeNormalVersionCode(2281)))
      .toBeLessThanOrEqual(appVersionContract.android_version_code_max);
  });
});
