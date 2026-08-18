import { describe, expect, it } from 'vitest';
import { evaluateApkSmokeDeviceReadiness } from './android-apk-smoke-device-readiness';

describe('android apk smoke device readiness', () => {
  it('accepts OEM policy dumps that still report keyguard showing when screen is on and interactive', () => {
    const verdict = evaluateApkSmokeDeviceReadiness(
      `mWakefulness=Awake\nmHoldingDisplaySuspendBlocker=true`,
      `showing=true\nscreenState=SCREEN_STATE_ON\ninteractiveState=INTERACTIVE_STATE_AWAKE`,
    );

    expect(verdict.ready).toBe(true);
    expect(verdict.awake).toBe(true);
    expect(verdict.screenOn).toBe(true);
    expect(verdict.keyguardShowing).toBe(true);
  });

  it('rejects sleeping devices even if policy still contains a stale keyguard block', () => {
    const verdict = evaluateApkSmokeDeviceReadiness(
      `mWakefulness=Asleep`,
      `showing=true\nscreenState=SCREEN_STATE_OFF\ninteractiveState=INTERACTIVE_STATE_SLEEP`,
    );

    expect(verdict.ready).toBe(false);
    expect(verdict.awake).toBe(false);
    expect(verdict.screenOn).toBe(false);
  });
});
