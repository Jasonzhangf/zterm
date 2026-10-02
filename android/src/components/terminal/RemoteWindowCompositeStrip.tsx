import { AmbientButton } from '../ambient';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowCompositeStripProps {
  windowIds: string[];
  activeWindowId: string;
  focusedWindowId: string | null;
  canvasRefs: { current: Map<string, HTMLCanvasElement | null> };
  onFocusWindow: (windowId: string) => void;
}

// Catalog-less fallback only: when no app group exists the daemon canvas is
// still the only way to reach sibling windows. Bounded thumbnail band, never a
// second full-height switcher over the video.
export function RemoteWindowCompositeStrip({
  windowIds,
  activeWindowId,
  focusedWindowId,
  canvasRefs,
  onFocusWindow,
}: RemoteWindowCompositeStripProps) {
  if (windowIds.length === 0) {
    return null;
  }
  return (
    <div data-testid="remote-window-composite-strip" data-no-drag="true" style={styles.compositeStrip}>
      <div
        data-testid="remote-window-composite-thumbnails"
        style={styles.compositeThumbRow}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
      >
        {windowIds.map((windowId) => {
          const focused = focusedWindowId === windowId;
          return (
            <AmbientButton
              key={windowId}
              type="button"
              data-testid={`remote-window-composite-thumb-${windowId}`}
              data-focused={focused ? 'true' : undefined}
              onClick={() => onFocusWindow(windowId)}
              style={{
                ...styles.compositeThumbButton,
                ...(focused ? styles.compositeThumbButtonFocused : null),
              }}
            >
              <canvas
                ref={(node) => {
                  canvasRefs.current.set(windowId, node);
                }}
                width={64}
                height={44}
                style={styles.compositeThumbCanvas}
              />
              <span style={styles.compositeThumbLabel}>
                {windowId === activeWindowId ? '主' : '子'}
              </span>
            </AmbientButton>
          );
        })}
      </div>
    </div>
  );
}

export function resolveCompositeStripWindowIds(
  windows: Array<{ windowId: string }>,
): string[] {
  return windows.slice(1).map((slot) => slot.windowId);
}

export function findCompositeStripTarget(
  targets: RemoteWindowStreamTargetManifest[],
  windowId: string,
): RemoteWindowStreamTargetManifest | null {
  return targets.find((item) => item.videoTarget.windowId === windowId) ?? null;
}
