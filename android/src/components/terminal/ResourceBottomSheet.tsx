import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';

type ResourceTab = 'files' | 'web';

export interface ResourceBottomSheetProps {
  open: boolean;
  renderFileBrowser: (open: boolean) => ReactNode;
  webUrl?: string;
  onWebUrlChange?: (url: string) => void;
  onClose: () => void;
  initialTab?: ResourceTab;
}

const SHEET_OVERLAY: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 94,
  display: 'flex',
  alignItems: 'flex-end',
  background: 'var(--zterm-sheet-overlay)',
};

const SHEET: React.CSSProperties = {
  width: '100%',
  height: 'min(86vh, 760px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--zterm-panel-bg)',
  color: 'var(--zterm-panel-text)',
  border: '1px solid var(--zterm-panel-border)',
  borderBottom: 0,
  borderRadius: '22px 22px 0 0',
  boxShadow: '0 -18px 48px var(--zterm-panel-shadow)',
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
  webUrl = '',
  onWebUrlChange,
  onClose,
  initialTab = 'files',
}: ResourceBottomSheetProps) {
  const [tab, setTab] = useState<ResourceTab>(initialTab);
  const [draftUrl, setDraftUrl] = useState(webUrl);
  const [submittedUrl, setSubmittedUrl] = useState(webUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const touchStartY = useRef<number | null>(null);

  useEffect(() => {
    setDraftUrl(webUrl);
    setSubmittedUrl(webUrl);
  }, [webUrl]);

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
    touchStartY.current = event.touches[0]?.clientY ?? null;
  };
  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchStartY.current;
    touchStartY.current = null;
    const end = event.changedTouches[0]?.clientY;
    if (start !== null && end !== undefined && end - start > 64) {
      onClose();
    }
  };

  const fileBrowserNode = renderFileBrowser(open && tab === 'files');

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
      style={SHEET_OVERLAY}
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <section
        data-testid="resource-bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="资源"
        style={SHEET}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 2px' }}>
          <span aria-hidden="true" style={{ width: 42, height: 4, borderRadius: 99, background: 'var(--zterm-panel-border)' }} />
        </div>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 12px' }}>
          <div style={{ flex: 1, fontSize: 18, fontWeight: 800 }}>资源</div>
          <button type="button" aria-label="关闭资源抽屉" style={buttonStyle} onClick={onClose}>关闭</button>
        </header>
        <nav aria-label="资源类型" style={{ display: 'flex', gap: 8, padding: '0 14px 10px' }}>
          {(['files', 'web'] as const).map((item) => (
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
              {item === 'files' ? '远程文件' : '网页'}
            </button>
          ))}
        </nav>
        <div style={{ minHeight: 0, flex: 1, display: tab === 'files' ? 'block' : 'none' }}>
          {fileBrowserNode}
        </div>
        {tab === 'web' ? (
          <div data-testid="resource-web-pane" style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: '0 14px 14px' }}>
            <form onSubmit={(event) => { event.preventDefault(); submitWebUrl(); }} style={{ display: 'flex', gap: 8 }}>
              <input
                aria-label="网页地址"
                value={draftUrl}
                onChange={(event) => setDraftUrl(event.target.value)}
                placeholder="https://example.com"
                inputMode="url"
                style={{ flex: 1, minWidth: 0, minHeight: 40, borderRadius: 12, border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-surface)', color: 'var(--zterm-panel-text)', padding: '0 12px', fontSize: 14 }}
              />
              <button type="submit" style={buttonStyle}>打开</button>
            </form>
            {urlError ? <div role="alert" style={{ color: 'var(--zterm-panel-danger)', fontSize: 13 }}>{urlError}</div> : null}
            {submittedUrl ? (
              <iframe
                title="网页渲染"
                src={submittedUrl}
                sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
                referrerPolicy="no-referrer"
                style={{ flex: 1, minHeight: 0, width: '100%', border: '1px solid var(--zterm-panel-border)', borderRadius: 14, background: 'var(--zterm-panel-surface)' }}
              />
            ) : (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--zterm-panel-muted)', fontSize: 14 }}>输入网址后在这里渲染网页</div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
