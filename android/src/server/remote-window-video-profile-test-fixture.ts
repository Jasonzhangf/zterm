import type {
  RemoteWindowVideoPreference,
  RemoteWindowVideoProfile,
} from '@zterm/shared/protocol';

export function makeRemoteWindowVideoProfileFixture(
  preference: RemoteWindowVideoPreference,
  interactionActive = false,
): RemoteWindowVideoProfile {
  if (preference === 'smooth') {
    return {
      preference,
      maxBitrateBps: interactionActive ? 8_000_000 : 6_000_000,
      maxFrameRateFps: interactionActive ? 45 : 30,
      maxCaptureWidth: interactionActive ? 1280 : 1440,
      maxCaptureHeight: interactionActive ? 800 : 900,
      maxFrameAgeMs: interactionActive ? 80 : 100,
      interactionActive,
      overviewMaxBitrateBps: interactionActive ? 150_000 : 250_000,
      overviewMaxFrameRateFps: interactionActive ? 1 : 2,
    };
  }
  return {
    preference,
    maxBitrateBps: interactionActive ? 18_000_000 : 16_000_000,
    maxFrameRateFps: 30,
    maxCaptureWidth: 1920,
    maxCaptureHeight: 1200,
    maxFrameAgeMs: interactionActive ? 120 : 150,
    interactionActive,
    overviewMaxBitrateBps: interactionActive ? 150_000 : 300_000,
    overviewMaxFrameRateFps: interactionActive ? 1 : 2,
  };
}
