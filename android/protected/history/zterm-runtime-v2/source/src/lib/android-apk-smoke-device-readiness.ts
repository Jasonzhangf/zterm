export interface ApkSmokeDeviceReadinessVerdict {
  ready: boolean;
  awake: boolean;
  screenOn: boolean;
  keyguardShowing: boolean;
}

export function evaluateApkSmokeDeviceReadiness(powerDump: string, policyDump: string) {
  const awake = /mWakefulness=Awake/m.test(powerDump)
    || /interactiveState=INTERACTIVE_STATE_AWAKE/m.test(policyDump);
  const screenOn = /screenState=SCREEN_STATE_ON/m.test(policyDump)
    || /mScreenOnEarly=true/m.test(powerDump)
    || /mHoldingDisplaySuspendBlocker=true/m.test(powerDump);
  const keyguardShowing = /showing=true/m.test(policyDump);
  return {
    ready: awake && screenOn,
    awake,
    screenOn,
    keyguardShowing,
  } satisfies ApkSmokeDeviceReadinessVerdict;
}
