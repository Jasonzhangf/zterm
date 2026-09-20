// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowOverlay } from './RemoteWindowOverlay';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';

const backListeners: Array<() => void> = [];

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, handler: () => void) => {
      backListeners.push(handler);
      return {
        remove: vi.fn(() => {
          const index = backListeners.indexOf(handler);
          if (index >= 0) {
            backListeners.splice(index, 1);
          }
        }),
      };
    }),
  },
}));

function makeTarget(): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: 'app-1',
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.apple.TextEdit',
      pid: 123,
      windowId: 'window-1',
      title: 'TextEdit',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 40, width: 800, height: 560 },
    },
    inputTarget: { kind: 'app-window' },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-09-13T00:00:00.000Z',
    },
  };
}

function remotePayloads(sendInput: ReturnType<typeof vi.fn>) {
  return sendInput.mock.calls.map((call) => call[1]).filter(Boolean);
}

function scrollPayloads(sendInput: ReturnType<typeof vi.fn>) {
  return remotePayloads(sendInput).filter((payload) => payload.event.kind === 'scroll');
}

function nonScrollPayloads(sendInput: ReturnType<typeof vi.fn>) {
  return remotePayloads(sendInput).filter((payload) => payload.event.kind !== 'scroll');
}

async function flushRemoteWindowSurfaceLayout() {
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
  });
}

async function openRemoteWindow(fullscreen: boolean) {
  const sendInput = vi.fn();
  const mediaStream = { id: 'media-stream-1' } as MediaStream;
  const requestTargets = vi.fn(async () => ({
    requestId: 'rw-1',
    targets: [makeTarget()],
  }));
  const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
    streamId,
    mediaStream,
  }));

  const { rerender } = render(
    <RemoteWindowOverlay
      activeSessionId="session-1"
      embedded
      requestTargets={requestTargets}
      startStream={startStream}
      sendInput={sendInput}
    />,
  );

  await screen.findByTestId('remote-window-target-app-1');
  fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
  await screen.findByTestId('remote-window-video');

  if (fullscreen) {
    rerender(<RemoteWindowOverlay activeSessionId="session-1" embedded embeddedFullscreen
      requestTargets={requestTargets} startStream={startStream} sendInput={sendInput} />);
  }
  await waitFor(() => {
    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode'))
      .toBe(fullscreen ? 'fullscreen' : 'floating');
  });

  const surface = screen.getByTestId('remote-window-video-surface');
  Object.defineProperty(surface, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 200,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    }),
  });
  await flushRemoteWindowSurfaceLayout();
  await waitFor(() => {
    expect(stylePx(projectionElement().style.width)).toBeGreaterThan(0);
  });

  return { sendInput, surface };
}

type GestureDirection = 'up' | 'down';

function projectionElement() {
  return screen.queryByTestId('remote-window-video-projection')
    ?? screen.getByTestId('remote-window-video-content');
}

let nextGesturePointerId = 500;

function nextPointerId() {
  nextGesturePointerId += 1;
  return nextGesturePointerId;
}

function touchOptions(pointerId: number, clientX: number, clientY: number, timeMs: number) {
  return {
    pointerId,
    pointerType: 'touch' as const,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
    timeStamp: timeMs,
  };
}

function touchUpOptions(pointerId: number, clientX: number, clientY: number) {
  return {
    pointerId,
    pointerType: 'touch' as const,
    clientX,
    clientY,
    button: 0,
    buttons: 0,
  };
}

function oneFingerVerticalMove(surface: HTMLElement, direction: GestureDirection) {
  const pointerId = nextPointerId();
  const startClientY = direction === 'up' ? 120 : 80;
  const endClientY = direction === 'up' ? 70 : 130;
  fireEvent.pointerDown(surface, touchOptions(pointerId, 150, startClientY, 1000));
  fireEvent.pointerMove(surface, touchOptions(pointerId, 150, endClientY, 1020));
  return { pointerId, startClientX: 150, startClientY, endClientX: 150, endClientY };
}

function oneFingerLocalPanThenSecondFingerVerticalMove(
  surface: HTMLElement,
  direction: GestureDirection,
) {
  const firstPointerId = nextPointerId();
  const secondPointerId = nextPointerId();
  const startClientY = direction === 'up' ? 120 : 80;
  const oneFingerClientY = direction === 'up' ? 90 : 110;
  const endClientY = direction === 'up' ? 60 : 140;
  const startFirstX = 120;
  const startSecondX = 180;
  fireEvent.pointerDown(surface, touchOptions(firstPointerId, startFirstX, startClientY, 2500));
  fireEvent.pointerMove(surface, touchOptions(firstPointerId, startFirstX, oneFingerClientY, 2520));
  fireEvent.pointerDown(surface, touchOptions(secondPointerId, startSecondX, oneFingerClientY, 2540));
  fireEvent.pointerMove(surface, touchOptions(firstPointerId, startFirstX, endClientY, 2560));
  fireEvent.pointerMove(surface, touchOptions(secondPointerId, startSecondX, endClientY, 2580));
  return {
    firstPointerId,
    secondPointerId,
    startFirstX,
    startSecondX,
    endClientY,
  };
}

function twoFingerVerticalMove(surface: HTMLElement, direction: GestureDirection) {
  const firstPointerId = nextPointerId();
  const secondPointerId = nextPointerId();
  const startClientY = direction === 'up' ? 120 : 80;
  const endClientY = direction === 'up' ? 70 : 130;
  const observeClientY = direction === 'up' ? 115 : 85;
  const startFirstX = 30;
  const startSecondX = 270;
  const endFirstX = 40;
  const endSecondX = 260;
  fireEvent.pointerDown(surface, touchOptions(firstPointerId, startFirstX, startClientY, 2000));
  fireEvent.pointerDown(surface, touchOptions(secondPointerId, startSecondX, startClientY, 2000));
  fireEvent.pointerMove(surface, touchOptions(firstPointerId, startFirstX, observeClientY, 2020));
  fireEvent.pointerMove(surface, touchOptions(firstPointerId, endFirstX, endClientY, 2040));
  fireEvent.pointerMove(surface, touchOptions(secondPointerId, endSecondX, endClientY, 2060));
  return { firstPointerId, secondPointerId, startClientY, endClientY, endFirstX, endSecondX };
}

function twoFingerHorizontalMove(surface: HTMLElement, direction: 'left' | 'right') {
  const firstPointerId = nextPointerId();
  const secondPointerId = nextPointerId();
  const startClientX = direction === 'left' ? 220 : 80;
  const endClientX = direction === 'left' ? 160 : 140;
  const observeClientX = direction === 'left' ? 210 : 90;
  const startFirstY = 60;
  const startSecondY = 140;
  fireEvent.pointerDown(surface, touchOptions(firstPointerId, startClientX, startFirstY, 2100));
  fireEvent.pointerDown(surface, touchOptions(secondPointerId, startClientX, startSecondY, 2100));
  fireEvent.pointerMove(surface, touchOptions(firstPointerId, observeClientX, startFirstY, 2120));
  fireEvent.pointerMove(surface, touchOptions(firstPointerId, endClientX, startFirstY, 2140));
  fireEvent.pointerMove(surface, touchOptions(secondPointerId, endClientX, startSecondY, 2160));
  return { firstPointerId, secondPointerId, endClientX, startFirstY, startSecondY };
}

function pinchMove(surface: HTMLElement, direction: 'in' | 'out') {
  const firstPointerId = nextPointerId();
  const secondPointerId = nextPointerId();
  const startX = direction === 'out' ? 100 : 110;
  const startX2 = direction === 'out' ? 200 : 190;
  const endX = direction === 'out' ? 70 : 145;
  const endX2 = direction === 'out' ? 260 : 155;
  fireEvent.pointerDown(surface, touchOptions(firstPointerId, startX, 100, 3000));
  fireEvent.pointerDown(surface, touchOptions(secondPointerId, startX2, 100, 3000));
  fireEvent.pointerMove(surface, touchOptions(firstPointerId, endX, 100, 3020));
  fireEvent.pointerMove(surface, touchOptions(secondPointerId, endX2, 100, 3020));
  return { firstPointerId, secondPointerId, firstEndX: endX, secondEndX: endX2, y: 100 };
}

async function releasePointer(surface: HTMLElement, pointerId: number, clientX: number, clientY: number) {
  fireEvent.pointerUp(surface, touchUpOptions(pointerId, clientX, clientY));
  await act(async () => {});
}

async function releasePair(
  surface: HTMLElement,
  firstPointerId: number,
  secondPointerId: number,
  firstClientX: number,
  secondClientX: number,
  clientY: number,
) {
  await releasePointer(surface, firstPointerId, firstClientX, clientY);
  await releasePointer(surface, secondPointerId, secondClientX, clientY);
}

function stylePx(value: string | undefined) {
  const parsed = Number.parseFloat(value || '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function fitWidth() {
  return Math.min(300 / 800, 200 / 560) * 800;
}

function expectOnlyVerticalRemoteScrolls(sendInput: ReturnType<typeof vi.fn>) {
  const payloads = remotePayloads(sendInput);
  expect(payloads.length).toBeGreaterThan(0);
  expect(payloads.every((payload) => payload.event.kind === 'scroll' && payload.event.deltaX === 0)).toBe(true);
}

function lastScrollDeltaY(sendInput: ReturnType<typeof vi.fn>) {
  const payloads = scrollPayloads(sendInput);
  expect(payloads.length).toBeGreaterThan(0);
  return payloads[payloads.length - 1].event.deltaY as number;
}

function expectScrollDirection(sendInput: ReturnType<typeof vi.fn>, direction: GestureDirection) {
  const deltaY = lastScrollDeltaY(sendInput);
  if (direction === 'down') {
    expect(deltaY).toBeLessThan(0);
  } else {
    expect(deltaY).toBeGreaterThan(0);
  }
}

describe('RemoteWindowOverlay gesture matrix', () => {
  beforeEach(() => {
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn(() => 1),
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    backListeners.splice(0, backListeners.length);
    window.localStorage.clear();
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
  });

  it('keeps the embedded half-sheet preview passive and enables gestures only after fullscreen', async () => {
    const preview = await openRemoteWindow(false);
    const content = projectionElement();
    const widthBefore = stylePx(content.style.width);
    const topBefore = stylePx(content.style.top);

    const previewOneFinger = oneFingerVerticalMove(preview.surface, 'up');
    await act(async () => {});
    await releasePointer(
      preview.surface,
      previewOneFinger.pointerId,
      previewOneFinger.endClientX,
      previewOneFinger.endClientY,
    );
    expect(remotePayloads(preview.sendInput)).toEqual([]);

    const previewPinch = pinchMove(preview.surface, 'out');
    await act(async () => {});
    await releasePair(
      preview.surface,
      previewPinch.firstPointerId,
      previewPinch.secondPointerId,
      previewPinch.firstEndX,
      previewPinch.secondEndX,
      previewPinch.y,
    );
    expect(remotePayloads(preview.sendInput)).toEqual([]);
    expect(stylePx(content.style.width)).toBe(widthBefore);
    expect(stylePx(content.style.top)).toBe(topBefore);

    cleanup();
    const fullscreen = await openRemoteWindow(true);
    const fullscreenGesture = oneFingerVerticalMove(fullscreen.surface, 'up');
    await waitFor(() => {
      expect(scrollPayloads(fullscreen.sendInput).length).toBeGreaterThan(0);
    });
    await releasePointer(
      fullscreen.surface,
      fullscreenGesture.pointerId,
      fullscreenGesture.endClientX,
      fullscreenGesture.endClientY,
    );
    expectOnlyVerticalRemoteScrolls(fullscreen.sendInput);
  });

  it('does not let an embedded half-sheet video double-click bypass the drawer promotion owner', async () => {
    const preview = await openRemoteWindow(false);

    fireEvent.doubleClick(preview.surface);
    await act(async () => {});

    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('floating');
    expect(remotePayloads(preview.sendInput)).toEqual([]);
  });

  it('keeps an embedded half-sheet touch double-tap passive and drawer-owned', async () => {
    const preview = await openRemoteWindow(false);
    const first = nextPointerId();
    const second = nextPointerId();

    fireEvent.pointerDown(preview.surface, touchOptions(first, 150, 100, 1000));
    await releasePointer(preview.surface, first, 150, 100);
    fireEvent.pointerDown(preview.surface, touchOptions(second, 150, 100, 1200));
    await releasePointer(preview.surface, second, 150, 100);

    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('floating');
    expect(remotePayloads(preview.sendInput)).toEqual([]);
  });

  it('routes unzoomed one-finger and two-finger vertical movement to remote scroll', async () => {
    for (const direction of ['up', 'down'] as const) {
      const { sendInput, surface } = await openRemoteWindow(true);
      const gesture = oneFingerVerticalMove(surface, direction);
      await waitFor(() => {
        expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
      });
      expectScrollDirection(sendInput, direction);
      const countBeforeRelease = remotePayloads(sendInput).length;
      await releasePointer(surface, gesture.pointerId, gesture.endClientX, gesture.endClientY);
      expect(remotePayloads(sendInput)).toHaveLength(countBeforeRelease);
      expect(nonScrollPayloads(sendInput)).toEqual([]);
      cleanup();
    }

    for (const direction of ['up', 'down'] as const) {
      const { sendInput, surface } = await openRemoteWindow(true);
      const gesture = twoFingerVerticalMove(surface, direction);
      await waitFor(() => {
        expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
      });
      expectScrollDirection(sendInput, direction);
      expectOnlyVerticalRemoteScrolls(sendInput);
      const countBeforeRelease = remotePayloads(sendInput).length;
      await releasePointer(surface, gesture.firstPointerId, gesture.endFirstX, gesture.endClientY);
      expect(remotePayloads(sendInput)).toHaveLength(countBeforeRelease);
      await releasePointer(surface, gesture.secondPointerId, gesture.endSecondX, gesture.endClientY);
      expect(remotePayloads(sendInput)).toHaveLength(countBeforeRelease);
      expect(nonScrollPayloads(sendInput)).toEqual([]);
      cleanup();
    }
  });

  it('keeps pinch local and restores 1x single-finger scroll after pinch-back', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);
    expect(initialWidth).toBeGreaterThan(0);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    expect(remotePayloads(sendInput)).toEqual([]);
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    expect(remotePayloads(sendInput)).toEqual([]);

    const zoomedOne = oneFingerVerticalMove(surface, 'up');
    await act(async () => {});
    expect(remotePayloads(sendInput)).toEqual([]);
    await releasePointer(surface, zoomedOne.pointerId, zoomedOne.endClientX, zoomedOne.endClientY);
    expect(remotePayloads(sendInput)).toEqual([]);

    const pinchIn = pinchMove(surface, 'in');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeLessThanOrEqual(fitWidth() + 1);
      expect(stylePx(content.style.width)).toBeGreaterThan(fitWidth() - 1);
    });
    expect(remotePayloads(sendInput)).toEqual([]);
    await releasePair(
      surface,
      pinchIn.firstPointerId,
      pinchIn.secondPointerId,
      pinchIn.firstEndX,
      pinchIn.secondEndX,
      pinchIn.y,
    );
    expect(remotePayloads(sendInput)).toEqual([]);

    sendInput.mockClear();
    const recovered = oneFingerVerticalMove(surface, 'down');
    await waitFor(() => {
      expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
    });
    expectScrollDirection(sendInput, 'down');
    expectOnlyVerticalRemoteScrolls(sendInput);
    await releasePointer(surface, recovered.pointerId, recovered.endClientX, recovered.endClientY);
    expectOnlyVerticalRemoteScrolls(sendInput);
  });

  it('suppresses zoomed one-finger and routes zoomed two-finger vertical motion to remote scroll', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    expect(remotePayloads(sendInput)).toEqual([]);

    for (const direction of ['up', 'down'] as const) {
      sendInput.mockClear();
      const topBeforePan = stylePx(content.style.top);
      const zoomedOne = oneFingerVerticalMove(surface, direction);
      await act(async () => {});
      expect(stylePx(content.style.top)).toBe(topBeforePan);
      expect(remotePayloads(sendInput)).toEqual([]);
      await releasePointer(surface, zoomedOne.pointerId, zoomedOne.endClientX, zoomedOne.endClientY);
      expect(remotePayloads(sendInput)).toEqual([]);
    }

    for (const direction of ['up', 'down'] as const) {
      sendInput.mockClear();
      const widthBeforeScroll = stylePx(content.style.width);
      const gesture = twoFingerVerticalMove(surface, direction);
      await waitFor(() => {
        expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
      });
      expectScrollDirection(sendInput, direction);
      expect(stylePx(content.style.width)).toBe(widthBeforeScroll);
      expectOnlyVerticalRemoteScrolls(sendInput);
      const countBeforeRelease = remotePayloads(sendInput).length;
      await releasePointer(surface, gesture.firstPointerId, gesture.endFirstX, gesture.endClientY);
      expect(remotePayloads(sendInput)).toHaveLength(countBeforeRelease);
      await releasePointer(surface, gesture.secondPointerId, gesture.endSecondX, gesture.endClientY);
      expect(remotePayloads(sendInput)).toHaveLength(countBeforeRelease);
      expect(nonScrollPayloads(sendInput)).toEqual([]);
    }
  });

  it('keeps the zoomed one-finger projection unchanged after release', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    sendInput.mockClear();

    const topBeforePan = stylePx(content.style.top);
    const pan = oneFingerVerticalMove(surface, 'up');
    await act(async () => {});
    expect(stylePx(content.style.top)).toBe(topBeforePan);

    await releasePointer(surface, pan.pointerId, pan.endClientX, pan.endClientY);

    expect(stylePx(content.style.top)).toBe(topBeforePan);
    expect(remotePayloads(sendInput)).toEqual([]);
  });

  it('keeps a zoomed fullscreen projection when the surface double-clicks', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    sendInput.mockClear();

    const zoomedWidth = stylePx(content.style.width);
    const zoomedTop = stylePx(content.style.top);
    expect(zoomedWidth).toBeGreaterThan(initialWidth + 1);

    fireEvent.doubleClick(surface);
    await act(async () => {});

    expect(stylePx(content.style.width)).toBe(zoomedWidth);
    expect(stylePx(content.style.top)).toBe(zoomedTop);
    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('fullscreen');
    expect(remotePayloads(sendInput)).toEqual([]);
  });

  it('upgrades a suppressed one-finger sequence to fullscreen remote scroll', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    await waitFor(() => {
      expect(remotePayloads(sendInput)).toEqual([]);
    });

    const topBeforeTwoFingerGesture = stylePx(content.style.top);
    const gesture = oneFingerLocalPanThenSecondFingerVerticalMove(surface, 'up');
    await waitFor(() => {
      expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
    });
    expectScrollDirection(sendInput, 'up');
    expectOnlyVerticalRemoteScrolls(sendInput);
    expect(stylePx(content.style.top)).toBe(topBeforeTwoFingerGesture);

    const countBeforeRelease = remotePayloads(sendInput).length;
    await releasePointer(surface, gesture.firstPointerId, gesture.startFirstX, gesture.endClientY);
    await releasePointer(surface, gesture.secondPointerId, gesture.startSecondX, gesture.endClientY);
    expect(remotePayloads(sendInput)).toHaveLength(countBeforeRelease);
    expect(nonScrollPayloads(sendInput)).toEqual([]);
  });

  it('classifies the first pair sample after a second finger upgrades a suppressed zoomed one-finger sequence', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    sendInput.mockClear();

    const firstPointerId = nextPointerId();
    const secondPointerId = nextPointerId();
    const topBeforePan = stylePx(content.style.top);
    fireEvent.pointerDown(surface, touchOptions(firstPointerId, 120, 120, 8000));
    fireEvent.pointerMove(surface, touchOptions(firstPointerId, 120, 90, 8020));
    await act(async () => {});
    expect(stylePx(content.style.top)).toBe(topBeforePan);

    fireEvent.pointerDown(surface, touchOptions(secondPointerId, 180, 90, 8040));
    await waitFor(() => {
      expect(stylePx(content.style.top)).toBe(topBeforePan);
    });

    fireEvent.pointerMove(surface, touchOptions(firstPointerId, 120, 60, 8060));
    fireEvent.pointerMove(surface, touchOptions(secondPointerId, 180, 60, 8080));
    expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
    expectScrollDirection(sendInput, 'up');
    expectOnlyVerticalRemoteScrolls(sendInput);

    await releasePointer(surface, firstPointerId, 120, 60);
    await releasePointer(surface, secondPointerId, 180, 60);
    expect(nonScrollPayloads(sendInput)).toEqual([]);
  });

  it('keeps the zoomed viewport unchanged as a second finger enters a pair gesture', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    sendInput.mockClear();

    const firstPointerId = nextPointerId();
    const secondPointerId = nextPointerId();
    const topBeforePan = stylePx(content.style.top);
    fireEvent.pointerDown(surface, touchOptions(firstPointerId, 120, 120, 7000));
    fireEvent.pointerMove(surface, touchOptions(firstPointerId, 120, 90, 7020));
    await act(async () => {});
    expect(stylePx(content.style.top)).toBe(topBeforePan);

    fireEvent.pointerDown(surface, touchOptions(secondPointerId, 180, 90, 7040));

    await waitFor(() => {
      expect(stylePx(content.style.top)).toBe(topBeforePan);
    });
    expect(remotePayloads(sendInput)).toEqual([]);

    await releasePointer(surface, firstPointerId, 120, 90);
    await releasePointer(surface, secondPointerId, 180, 90);
    expect(remotePayloads(sendInput)).toEqual([]);
  });

  it('routes zoomed two-finger horizontal same-direction motion to remote scroll without moving the viewport', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    expect(remotePayloads(sendInput)).toEqual([]);

    for (const direction of ['left', 'right'] as const) {
      sendInput.mockClear();
      const before = { left: stylePx(content.style.left), top: stylePx(content.style.top), width: stylePx(content.style.width) };
      const gesture = twoFingerHorizontalMove(surface, direction);
      await waitFor(() => {
        expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
      });
      // Horizontal same-direction motion must preserve the horizontal delta.
      expect(scrollPayloads(sendInput).every((payload) => payload.event.deltaX !== 0)).toBe(true);
      expect(scrollPayloads(sendInput).every((payload) => payload.event.deltaY === 0)).toBe(true);
      expect(nonScrollPayloads(sendInput)).toEqual([]);
      expect(stylePx(content.style.left)).toBe(before.left);
      expect(stylePx(content.style.top)).toBe(before.top);
      expect(stylePx(content.style.width)).toBe(before.width);

      const countBeforeRelease = remotePayloads(sendInput).length;
      await releasePointer(surface, gesture.firstPointerId, gesture.endClientX, gesture.startFirstY);
      await releasePointer(surface, gesture.secondPointerId, gesture.endClientX, gesture.startSecondY);
      expect(remotePayloads(sendInput)).toHaveLength(countBeforeRelease);
      expect(nonScrollPayloads(sendInput)).toEqual([]);
    }
    cleanup();
  });

  it('upgrades a suppressed one-finger sequence to fullscreen pinch', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    await waitFor(() => {
      expect(remotePayloads(sendInput)).toEqual([]);
    });

    const topBeforeTwoFingerGesture = stylePx(content.style.top);
    const widthBeforeTwoFingerGesture = stylePx(content.style.width);
    const firstPointerId = nextPointerId();
    const secondPointerId = nextPointerId();
    fireEvent.pointerDown(surface, touchOptions(firstPointerId, 130, 120, 4000));
    fireEvent.pointerMove(surface, touchOptions(firstPointerId, 130, 90, 4020));
    expect(stylePx(content.style.top)).toBe(topBeforeTwoFingerGesture);
    fireEvent.pointerDown(surface, touchOptions(secondPointerId, 170, 90, 4040));
    fireEvent.pointerMove(surface, touchOptions(firstPointerId, 105, 90, 4060));
    fireEvent.pointerMove(surface, touchOptions(secondPointerId, 195, 90, 4080));

    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(widthBeforeTwoFingerGesture + 1);
    });
    // Pinch is anchored at the pair midpoint, so the viewport may move while
    // preserving the zoom anchor. The invariant here is that the pre-upgrade
    // one-finger move does not become a remote input or a two-finger pan.
    expect(stylePx(content.style.top)).not.toBe(topBeforeTwoFingerGesture);
    expect(remotePayloads(sendInput)).toEqual([]);

    await releasePointer(surface, firstPointerId, 105, 90);
    await releasePointer(surface, secondPointerId, 195, 90);
    expect(remotePayloads(sendInput)).toEqual([]);
  });

  it('suppresses pointerCancel tap and recovers the next pointer sequence', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const cancelledPointerId = nextPointerId();
    fireEvent.pointerDown(surface, touchOptions(cancelledPointerId, 150, 100, 4000));
    fireEvent.pointerCancel(surface, touchUpOptions(cancelledPointerId, 150, 100));
    await act(async () => {});
    expect(remotePayloads(sendInput)).toEqual([]);

    const recovered = oneFingerVerticalMove(surface, 'up');
    await waitFor(() => {
      expect(scrollPayloads(sendInput).length).toBeGreaterThan(0);
    });
    expectOnlyVerticalRemoteScrolls(sendInput);
    await releasePointer(surface, recovered.pointerId, recovered.endClientX, recovered.endClientY);
    expectOnlyVerticalRemoteScrolls(sendInput);
  });

  it('cancels the long-press timer when a second finger enters a zoomed gesture', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    sendInput.mockClear();

    vi.useFakeTimers();
    const firstPointerId = nextPointerId();
    const secondPointerId = nextPointerId();
    fireEvent.pointerDown(surface, touchOptions(firstPointerId, 110, 100, 5000));
    fireEvent.pointerDown(surface, touchOptions(secondPointerId, 190, 100, 5010));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(remotePayloads(sendInput)).toEqual([]);
    await releasePointer(surface, firstPointerId, 110, 100);
    await releasePointer(surface, secondPointerId, 190, 100);
    expect(remotePayloads(sendInput)).toEqual([]);
  });

  it('does not resume first-finger local pan after a second finger lifts below the upgrade threshold', async () => {
    const { sendInput, surface } = await openRemoteWindow(true);
    const content = projectionElement();
    const initialWidth = stylePx(content.style.width);

    const zoomOut = pinchMove(surface, 'out');
    await waitFor(() => {
      expect(stylePx(content.style.width)).toBeGreaterThan(initialWidth + 1);
    });
    await releasePair(
      surface,
      zoomOut.firstPointerId,
      zoomOut.secondPointerId,
      zoomOut.firstEndX,
      zoomOut.secondEndX,
      zoomOut.y,
    );
    sendInput.mockClear();

    const firstPointerId = nextPointerId();
    const secondPointerId = nextPointerId();
    const topBeforeOneFinger = stylePx(content.style.top);
    fireEvent.pointerDown(surface, touchOptions(firstPointerId, 110, 120, 6000));
    fireEvent.pointerMove(surface, touchOptions(firstPointerId, 110, 135, 6010));
    await act(async () => {});
    const topWhenSecondFingerEntered = stylePx(content.style.top);
    expect(topWhenSecondFingerEntered).toBe(topBeforeOneFinger);

    fireEvent.pointerDown(surface, touchOptions(secondPointerId, 190, 135, 6020));
    fireEvent.pointerMove(surface, touchOptions(secondPointerId, 194, 135, 6030));
    await releasePointer(surface, secondPointerId, 194, 135);
    fireEvent.pointerMove(surface, touchOptions(firstPointerId, 110, 150, 6040));

    await act(async () => {});
    expect(stylePx(content.style.top)).toBe(topWhenSecondFingerEntered);
    expect(remotePayloads(sendInput)).toEqual([]);
    await releasePointer(surface, firstPointerId, 110, 150);
    expect(remotePayloads(sendInput)).toEqual([]);
  });
});
