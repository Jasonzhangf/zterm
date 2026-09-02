import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';

type ResourceTab = 'files' | 'web' | 'stream';
type ResourcePlacement = 'bottom' | 'end';

export interface ResourceBottomSheetProps {
  open: boolean;
  renderFileBrowser: (open: boolean) => ReactNode;
  renderRemoteWindow?: (open: boolean, tab?: 'stream' | 'web') => ReactNode;
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
  const touchStartY = useRef<number | null>(null);
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

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    touchStartY.current = event.touches[0]?.clientY ?? null;
  };
  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchStartY.current;
    touchStartY.current = null;
    const end = event.changedTouches[0]?.clientY;
    if (start !== null && end !== undefined) {
      const delta = end - start;
      if (delta > 64) onClose();
      if (delta < -64) {
        setExpanded(true);
        onExpand?.();
      }
    }
  };

  const fileBrowserNode = renderFileBrowser(open && tab === 'files');
  const remoteWindowNode = renderRemoteWindow
    ? tab === 'web'
      ? renderRemoteWindow(open, 'web')
      : renderRemoteWindow(open && tab === 'stream')
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
      data-placement={resolvedPlacement}
      style={{ ...SHEET_OVERLAY, alignItems: resolvedPlacement === 'end' ? 'stretch' : 'flex-end', justifyContent: resolvedPlacement === 'end' ? 'flex-end' : 'stretch' }}
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <section
        data-testid="resource-bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="资源"
          style={{ ...SHEET, width: resolvedPlacement === 'end' ? 'min(560px, 94vw)' : '100%', height: expanded || resolvedPlacement === 'end' ? '100%' : SHEET.height, borderRadius: resolvedPlacement === 'end' || expanded ? 0 : SHEET.borderRadius, borderBottom: resolvedPlacement === 'end' || expanded ? '1px solid var(--zterm-panel-border)' : 0, borderRight: 0 }}
      onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <span aria-hidden="true" style={{ width: 38, height: 4, borderRadius: 99, background: 'var(--zterm-panel-border)' }} />
        </div>
        {tab !== 'stream' ? <header style={{ display: 'grid', gridTemplateColumns: '44px 1fr 96px', alignItems: 'center', gap: 8, padding: '8px 16px 14px', borderBottom: '1px solid var(--zterm-panel-border)' }}>
          <button type="button" aria-label="关闭资源抽屉" style={{ ...buttonStyle, width: 44, padding: 0, border: 0, borderRadius: 22, fontSize: 13 }} onClick={onClose}>收起</button>
          <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>预览</div>
          <button type="button" aria-label="下载当前资源" disabled={!onDownload} onClick={onDownload} style={{ ...buttonStyle, border: 0, background: 'var(--zterm-panel-surface)', fontSize: 16, opacity: onDownload ? 1 : 0.5 }}>下载</button>
        </header> : null}
        <nav aria-label="资源类型" style={{ display: 'flex', gap: 6, padding: '10px 16px 8px' }}>
          {(['files', 'stream', 'web'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-selected={tab === item}
              style={{
                ...buttonStyle,
                flex: 1,
                background: tab === item ? 'var(--zterm-panel-accent)' : 'var(--zterm-panel-surface)',
                color: tab === item ? 'var(--zterm-panel-active-text)' : 'var(--zterm-panel-text)',
              }}
              onClick={() => setTab(item)}
            >
              {item === 'files' ? '远程文件' : item === 'stream' ? '窗口串流' : '网页'}
            </button>
          ))}
        </nav>
        <div style={{ minHeight: 0, flex: 1, display: tab === 'files' ? 'block' : 'none' }}>
          {fileBrowserNode}
        </div>
        {tab === 'stream' ? (
          <div data-testid="resource-stream-pane" style={{ minHeight: 0, flex: 1, position: 'relative', overflow: 'visible' }}>
            {remoteWindowNode || <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--zterm-panel-muted)' }}>窗口串流不可用</div>}
          </div>
        ) : null}
        {tab === 'web' ? (
          <div data-testid="resource-web-pane" style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: '0 14px 14px' }}>
            {remoteWindowNode ? remoteWindowNode : <form onSubmit={(event) => { event.preventDefault(); submitWebUrl(); }} style={{ display: 'flex', gap: 8 }}>
              <input
                aria-label="网页地址"
                value={draftUrl}
                onChange={(event) => setDraftUrl(event.target.value)}
                placeholder="https://example.com"
                inputMode="url"
                style={{ flex: 1, minWidth: 0, minHeight: 40, borderRadius: 12, border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-surface)', color: 'var(--zterm-panel-text)', padding: '0 12px', fontSize: 14 }}
              />
              <button type="submit" style={buttonStyle}>打开</button>
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
