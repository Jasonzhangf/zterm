import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode, type TouchEvent } from 'react';
import {
  createResourceDrawerGestureRuntime,
  resolveResourceDrawerGestureContext,
  RESOURCE_DRAWER_GESTURE_ATTRS,
  RESOURCE_DRAWER_GESTURE_PAGE_IDS,
  RESOURCE_DRAWER_GESTURE_SCOPE_IDS,
} from './resource-drawer-gesture-runtime';
import { AmbientButton, AmbientInput } from '../ambient';

type ResourceTab = 'files' | 'web' | 'stream';
type ResourcePlacement = 'bottom' | 'end';

export interface ResourceBottomSheetProps {
  open: boolean;
  renderFileBrowser: (open: boolean) => ReactNode;
  renderRemoteWindow?: (open: boolean, tab?: 'stream' | 'web', expanded?: boolean, onExitFullscreen?: () => void) => ReactNode;
  webUrl?: string;
  onWebUrlChange?: (url: string) => void;
  onClose: () => void;
  onExpand?: () => void;
  onDownload?: () => void;
  initialTab?: ResourceTab;
  placement?: ResourcePlacement;
}

const SHEET_OVERLAY: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Keep the stream controller's own media layer above the drawer chrome.
  zIndex: 40,
  display: 'flex',
  alignItems: 'flex-end',
  background: 'var(--zterm-sheet-overlay)',
};

const SHEET: React.CSSProperties = {
  width: '100%',
  height: 'min(52vh, 560px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--zterm-panel-bg)',
  color: 'var(--zterm-panel-text)',
  border: '1px solid var(--zterm-panel-border)',
  borderBottom: 0,
  borderRadius: '24px 24px 0 0',
  boxShadow: '0 -12px 36px var(--zterm-panel-shadow)',
};

const buttonStyle: React.CSSProperties = {
  minHeight: 38,
  border: '1px solid var(--zterm-panel-border)',
  borderRadius: 12,
  background: 'var(--zterm-panel-surface)',
  color: 'var(--zterm-panel-text)',
  fontSize: 14,
  fontWeight: 700,
  padding: '0 14px',
};

function setPointerCaptureSafely(element: HTMLElement, pointerId: number) {
  try {
    element.setPointerCapture?.(pointerId);
  } catch (error) {
    console.warn('[ResourceBottomSheet] pointer capture unavailable:', error);
  }
}

function releasePointerCaptureSafely(element: HTMLElement, pointerId: number) {
  try {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture?.(pointerId);
  } catch (error) {
    console.warn('[ResourceBottomSheet] pointer capture release unavailable:', error);
  }
}

function touchGestureKey(touch: { identifier?: number } | undefined) {
  return `touch:${touch?.identifier ?? 'primary'}`;
}

export function ResourceBottomSheet({
  open,
  renderFileBrowser,
  renderRemoteWindow,
  webUrl = '',
  onWebUrlChange,
  onClose,
  onExpand,
  onDownload,
  initialTab = 'files',
  placement,
}: ResourceBottomSheetProps) {
  const [tab, setTab] = useState<ResourceTab>(initialTab);
  const [expanded, setExpanded] = useState(false);
  const [draftUrl, setDraftUrl] = useState(webUrl);
  const [submittedUrl, setSubmittedUrl] = useState(webUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [responsivePlacement, setResponsivePlacement] = useState<ResourcePlacement>(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 768px)').matches ? 'end' : 'bottom'
  ));
  const gestureRuntime = useRef(createResourceDrawerGestureRuntime());
  const previousOpenRef = useRef(open);

  useEffect(() => {
    setDraftUrl(webUrl);
    setSubmittedUrl(webUrl);
  }, [webUrl]);

  useEffect(() => {
    if (!open) setExpanded(false);
    if (open && !previousOpenRef.current) {
      setTab(initialTab);
    }
    previousOpenRef.current = open;
  }, [initialTab, open]);

  useEffect(() => {
    if (placement) return;
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 768px)');
    const update = () => setResponsivePlacement(media.matches ? 'end' : 'bottom');
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [placement]);

  const resolvedPlacement = placement || responsivePlacement;
  const streamExpanded = expanded && tab === 'stream';
  const handleExitStreamFullscreen = useCallback(() => setExpanded(false), []);

  const submitWebUrl = useCallback(() => {
    const value = draftUrl.trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('仅支持 http:// 或 https:// 地址');
      }
      setUrlError(null);
      setSubmittedUrl(parsed.toString());
      onWebUrlChange?.(parsed.toString());
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : '网页地址无效');
    }
  }, [draftUrl, onWebUrlChange]);

  const handleGestureStart = (key: string, target: EventTarget | null, clientY: number) => {
    gestureRuntime.current.start(key, resolveResourceDrawerGestureContext(target), clientY);
  };
  const handleGestureEnd = (key: string, clientY: number) => {
    const action = gestureRuntime.current.end(key, clientY);
    if (action === 'close') onClose();
    if (action === 'expand') {
      setExpanded(true);
      onExpand?.();
    }
  };
  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0] ?? event.touches[0];
    handleGestureStart(touchGestureKey(touch), event.target, touch?.clientY ?? 0);
  };
  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const context = resolveResourceDrawerGestureContext(event.target);
    for (const touch of Array.from(event.changedTouches)) {
      const key = touchGestureKey(touch);
      if (context?.capability === 'drag') {
        handleGestureEnd(key, touch.clientY);
      } else {
        // Content/toolbar/backdrop touchend may still reach the shell when an
        // embedded surface retargets the sequence. It can release its own
        // consumed owner, but it must never complete the handle's drag.
        gestureRuntime.current.cancel(key);
      }
    }
  };
  const handleTouchCancel = (event: TouchEvent<HTMLDivElement>) => {
    const touches = event.changedTouches.length > 0 ? event.changedTouches : event.touches;
    if (touches.length === 0) {
      gestureRuntime.current.cancel(touchGestureKey(undefined));
      return;
    }
    for (const touch of Array.from(touches)) {
      gestureRuntime.current.cancel(touchGestureKey(touch));
    }
  };
  const handlePointerStart = (event: PointerEvent<HTMLDivElement>) => {
    handleGestureStart(`pointer:${event.pointerId}`, event.target, event.clientY);
  };
  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    handleGestureEnd(`pointer:${event.pointerId}`, event.clientY);
  };

  const fileBrowserNode = renderFileBrowser(open && tab === 'files');
  const remoteWindowNode = renderRemoteWindow
    ? tab === 'web'
      ? renderRemoteWindow(open, 'web', expanded)
      : renderRemoteWindow(open && tab === 'stream', 'stream', expanded, handleExitStreamFullscreen)
    : null;

  if (!open) {
    return (
      <div aria-hidden="true" style={{ display: 'none' }}>
        {renderFileBrowser(false)}
      </div>
    );
  }

  return (
    <div
      data-testid="resource-bottom-sheet-overlay"
      {...{ [RESOURCE_DRAWER_GESTURE_ATTRS.page]: RESOURCE_DRAWER_GESTURE_PAGE_IDS.backdrop, [RESOURCE_DRAWER_GESTURE_ATTRS.scope]: RESOURCE_DRAWER_GESTURE_SCOPE_IDS.drawerShell }}
      data-placement={resolvedPlacement}
      style={{ ...SHEET_OVERLAY, alignItems: resolvedPlacement === 'end' ? 'stretch' : 'flex-end', justifyContent: resolvedPlacement === 'end' ? 'flex-end' : 'stretch' }}
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      onPointerDown={handlePointerStart}
      onPointerUp={handlePointerEnd}
      onPointerCancel={(event) => gestureRuntime.current.cancel(`pointer:${event.pointerId}`)}
    >
      <section
        data-testid="resource-bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="资源"
        {...{ [RESOURCE_DRAWER_GESTURE_ATTRS.page]: RESOURCE_DRAWER_GESTURE_PAGE_IDS.shell, [RESOURCE_DRAWER_GESTURE_ATTRS.scope]: RESOURCE_DRAWER_GESTURE_SCOPE_IDS.drawerShell }}
          style={{ ...SHEET, width: resolvedPlacement === 'end' ? 'min(560px, 94vw)' : '100%', height: expanded || resolvedPlacement === 'end' ? '100%' : SHEET.height, borderRadius: resolvedPlacement === 'end' || expanded ? 0 : SHEET.borderRadius, borderBottom: resolvedPlacement === 'end' || expanded ? '1px solid var(--zterm-panel-border)' : 0, borderRight: 0 }}
      onClick={(event) => event.stopPropagation()}
      >
        {!streamExpanded ? <div
          data-testid="resource-bottom-sheet-grip"
          {...{ [RESOURCE_DRAWER_GESTURE_ATTRS.handle]: 'true' }}
          // Android WebView 会把把手上的竖向拖动当作滚动 pan 仲裁并发出
          // pointercancel，取消已激活的 drawer gesture，导致"半截 -> 全屏"
          // 上滑永远拿不到 touchend/pointerup。把手是显式拖动面，必须声明
          // touch-action: none 才能让浏览器把手势交给本组件。
          style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px', touchAction: 'none' }}
          onTouchStart={(event) => { event.stopPropagation(); handleTouchStart(event); }}
          onTouchEnd={(event) => { event.stopPropagation(); handleTouchEnd(event); }}
          onTouchCancel={(event) => { event.stopPropagation(); handleTouchCancel(event); }}
          onPointerDown={(event) => {
            event.stopPropagation();
            setPointerCaptureSafely(event.currentTarget, event.pointerId);
            handlePointerStart(event);
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            releasePointerCaptureSafely(event.currentTarget, event.pointerId);
            handlePointerEnd(event);
          }}
          onPointerCancel={(event) => {
            event.stopPropagation();
            releasePointerCaptureSafely(event.currentTarget, event.pointerId);
            gestureRuntime.current.cancel(`pointer:${event.pointerId}`);
          }}
        >
          <span aria-hidden="true" style={{ width: 38, height: 4, borderRadius: 99, background: 'var(--zterm-panel-border)' }} />
        </div> : null}
        {!streamExpanded ? <header style={{ display: 'grid', gridTemplateColumns: '44px 1fr 96px', alignItems: 'center', gap: 8, padding: '8px 16px 14px', borderBottom: '1px solid var(--zterm-panel-border)' }}>
          <AmbientButton type="button" aria-label="关闭资源抽屉" style={{ ...buttonStyle, width: 44, padding: 0, border: 0, borderRadius: 22, fontSize: 13 }} onClick={onClose}>收起</AmbientButton>
          <div style={{ textAlign: 'center', fontSize: tab === 'stream' ? 16 : 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{tab === 'stream' ? '窗口串流' : '预览'}</div>
          {tab === 'stream' ? null : <AmbientButton type="button" aria-label="下载当前资源" disabled={!onDownload} onClick={onDownload} style={{ ...buttonStyle, border: 0, background: 'var(--zterm-panel-surface)', fontSize: 16, opacity: onDownload ? 1 : 0.5 }}>下载</AmbientButton>}
        </header> : null}
        {!streamExpanded ? <nav aria-label="资源类型" {...{ [RESOURCE_DRAWER_GESTURE_ATTRS.page]: RESOURCE_DRAWER_GESTURE_PAGE_IDS.toolbar, [RESOURCE_DRAWER_GESTURE_ATTRS.scope]: RESOURCE_DRAWER_GESTURE_SCOPE_IDS.toolbar }} style={{ display: 'flex', gap: 6, padding: '10px 16px 8px' }} onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}>
          {(['files', 'stream', 'web'] as const).map((item) => (
            <AmbientButton
              key={item}
              type="button"
              aria-selected={tab === item}
              style={{
                ...buttonStyle,
                flex: 1,
                border: tab === item
                  ? '1px solid var(--zterm-panel-accent-border)'
                  : '1px solid var(--zterm-panel-border)',
                background: tab === item ? 'var(--zterm-panel-active)' : 'var(--zterm-panel-surface)',
                color: tab === item ? 'var(--zterm-panel-accent)' : 'var(--zterm-panel-text)',
              }}
              onClick={() => setTab(item)}
            >
              {item === 'files' ? '远程文件' : item === 'stream' ? '窗口串流' : '网页'}
            </AmbientButton>
          ))}
        </nav> : null}
        <div data-resource-drawer-page={RESOURCE_DRAWER_GESTURE_PAGE_IDS.files} data-resource-drawer-scope={RESOURCE_DRAWER_GESTURE_SCOPE_IDS.drawerContentPage} style={{ minHeight: 0, flex: 1, display: tab === 'files' ? 'block' : 'none' }} onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()} onTouchCancel={(event) => { event.stopPropagation(); handleTouchCancel(event); }} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onPointerCancel={(event) => { event.stopPropagation(); gestureRuntime.current.cancel(`pointer:${event.pointerId}`); }}>
          {fileBrowserNode}
        </div>
        {tab === 'stream' ? (
          <div
            data-testid="resource-stream-pane"
            data-resource-drawer-page={RESOURCE_DRAWER_GESTURE_PAGE_IDS.stream}
            data-resource-drawer-scope={RESOURCE_DRAWER_GESTURE_SCOPE_IDS.remoteWindowSurface}
            style={{ minHeight: 0, flex: 1, position: 'relative', overflow: 'visible' }}
            onTouchStart={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            onTouchCancel={(event) => { event.stopPropagation(); handleTouchCancel(event); }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => { event.stopPropagation(); gestureRuntime.current.cancel(`pointer:${event.pointerId}`); }}
          >
            {remoteWindowNode || <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--zterm-panel-muted)' }}>窗口串流不可用</div>}
          </div>
        ) : null}
        {tab === 'web' ? (
          <div data-testid="resource-web-pane" data-resource-drawer-page={RESOURCE_DRAWER_GESTURE_PAGE_IDS.web} data-resource-drawer-scope={RESOURCE_DRAWER_GESTURE_SCOPE_IDS.remoteWindowSurface} onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()} onTouchCancel={(event) => { event.stopPropagation(); handleTouchCancel(event); }} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onPointerCancel={(event) => { event.stopPropagation(); gestureRuntime.current.cancel(`pointer:${event.pointerId}`); }} style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: '0 14px 14px' }}>
            {remoteWindowNode ? remoteWindowNode : <form onSubmit={(event) => { event.preventDefault(); submitWebUrl(); }} style={{ display: 'flex', gap: 8 }}>
              <AmbientInput
                aria-label="网页地址"
                value={draftUrl}
                onChange={(event) => setDraftUrl(event.target.value)}
                placeholder="https://example.com"
                inputMode="url"
                style={{ flex: 1, minWidth: 0, minHeight: 40, borderRadius: 12, border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-surface)', color: 'var(--zterm-panel-text)', padding: '0 12px', fontSize: 14 }}
              />
              <AmbientButton type="submit" style={buttonStyle}>打开</AmbientButton>
            </form>}
            {!remoteWindowNode && urlError ? <div role="alert" style={{ color: 'var(--zterm-panel-danger)', fontSize: 13 }}>{urlError}</div> : null}
            {!remoteWindowNode && submittedUrl ? (
              <iframe
                title="网页渲染"
                src={submittedUrl}
                sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
                referrerPolicy="no-referrer"
                style={{ flex: 1, minHeight: 0, width: '100%', border: '1px solid var(--zterm-panel-border)', borderRadius: 14, background: 'var(--zterm-panel-surface)' }}
              />
            ) : !remoteWindowNode ? (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--zterm-panel-muted)', fontSize: 14 }}>输入网址后在这里渲染网页</div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
