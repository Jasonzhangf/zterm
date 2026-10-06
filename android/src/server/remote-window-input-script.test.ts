import { describe, expect, it } from 'vitest';
import { MACOS_REMOTE_WINDOW_INPUT_SWIFT } from './remote-window-input-script';

describe('remote-window-input-script', () => {
  it('routes key and close injection through the helper normalized native carrier only', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('let keyCodes: [String: CGKeyCode]');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let native: RemoteInputNativeCarrier?');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('try postNativeKeyCarrier(carrier, down: phase == "down")');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('try postNativeKeyCarrier(carrier, down: true)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('keyCodes["KeyW"]!');
  });

  it('observes combined-session state for the last-holder native release', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('CGEventSource.keyState(CGEventSourceStateID.combinedSessionState');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('CGEventSource.buttonState(CGEventSourceStateID.combinedSessionState');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func handleRelease');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('status: "unverified"');
  });

  it('reads back AX position and size after a successful resize setter', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('kAXPositionAttribute');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('kAXSizeAttribute');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('CFGetTypeID(positionRefValue) == AXValueGetTypeID()');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('CFGetTypeID(sizeRefValue) == AXValueGetTypeID()');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('positionRef as? AXValue');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('sizeRef as? AXValue');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('AXValueGetValue(');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('resizeTargetWindow(_ config: InputConfig) throws -> RemoteInputResizeObservation');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('RemoteInputResizeObservation');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('"operation"');
  });
});
