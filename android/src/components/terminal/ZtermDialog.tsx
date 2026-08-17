import { useEffect, type ReactNode } from 'react';

export type ZtermDialogTone = 'info' | 'success' | 'warning' | 'error';

export interface ZtermDialogProps {
  open: boolean;
  tone?: ZtermDialogTone;
  title: string;
  message?: ReactNode;
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  showCancel?: boolean;
  autoDismissMs?: number;
  onCancel?: () => void;
  onConfirm?: () => void;
}

const toneAccent: Record<ZtermDialogTone, string> = {
  info: 'var(--zterm-dialog-info, var(--zterm-panel-accent, #6aa7ff))',
  success: 'var(--zterm-dialog-success, var(--zterm-panel-accent, #1fd67a))',
  warning: 'var(--zterm-dialog-warning, var(--zterm-panel-danger, #ffb454))',
  error: 'var(--zterm-dialog-error, var(--zterm-panel-danger, #ff7e7e))',
};

const toneSoftBackground: Record<ZtermDialogTone, string> = {
  info: 'var(--zterm-dialog-info-soft, rgba(106,167,255,0.13))',
  success: 'var(--zterm-dialog-success-soft, rgba(31,214,122,0.13))',
  warning: 'var(--zterm-dialog-warning-soft, rgba(255,180,84,0.13))',
  error: 'var(--zterm-dialog-error-soft, rgba(255,126,126,0.13))',
};

const toneBorder: Record<ZtermDialogTone, string> = {
  info: 'var(--zterm-dialog-info-border, rgba(106,167,255,0.34))',
  success: 'var(--zterm-dialog-success-border, rgba(31,214,122,0.34))',
  warning: 'var(--zterm-dialog-warning-border, rgba(255,180,84,0.34))',
  error: 'var(--zterm-dialog-error-border, rgba(255,126,126,0.34))',
};

const toneGlyph: Record<ZtermDialogTone, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '×',
};

export function ZtermDialog({
  open,
  tone = 'info',
  title,
  message,
  detail,
  confirmLabel = '好的',
  cancelLabel = '取消',
  busy = false,
  showCancel = false,
  autoDismissMs,
  onCancel,
  onConfirm,
}: ZtermDialogProps) {
  useEffect(() => {
    if (!open || !autoDismissMs || autoDismissMs <= 0) {
      return;
    }
    const handle = window.setTimeout(() => {
      onConfirm?.();
    }, autoDismissMs);
    return () => window.clearTimeout(handle);
  }, [autoDismissMs, onConfirm, open]);

  if (!open) {
    return null;
  }

  const accent = toneAccent[tone];
  const glyph = toneGlyph[tone];
  const handleConfirm = () => {
    if (busy) {
      return;
    }
    onConfirm?.();
  };
  const handleCancel = () => {
    if (busy) {
      return;
    }
    onCancel?.();
  };

  return (
    <>
      <style>{`@keyframes ztermDialogFade{from{opacity:0}to{opacity:1}}@keyframes ztermDialogPop{from{transform:scale(.94);opacity:.4}to{transform:scale(1);opacity:1}}@keyframes ztermDialogSpin{to{transform:rotate(360deg)}}`}</style>
      <div
        data-testid="zterm-dialog"
        data-tone={tone}
        role="presentation"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 240,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '18px',
          backgroundColor: 'var(--zterm-sheet-overlay, rgba(8, 12, 20, 0.62))',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          animation: 'ztermDialogFade 160ms ease-out',
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            handleCancel();
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-testid="zterm-dialog-panel"
          style={{
            width: 'min(100%, 360px)',
            borderRadius: '18px',
            padding: '20px',
            boxSizing: 'border-box',
            background: 'var(--zterm-panel-bg, #101622)',
            color: 'var(--zterm-panel-text, #f5f7fb)',
            border: '1px solid var(--zterm-panel-border, rgba(255,255,255,0.14))',
            boxShadow: '0 24px 60px rgba(0,0,0,0.44)',
            animation: 'ztermDialogPop 220ms cubic-bezier(.2,.9,.3,1.2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <div
              aria-hidden="true"
              data-testid="zterm-dialog-glyph"
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: toneSoftBackground[tone],
                border: `1px solid ${toneBorder[tone]}`,
                color: accent,
                fontSize: '18px',
                fontWeight: 900,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              {busy ? (
                <span
                  style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    border: `2px solid ${toneBorder[tone]}`,
                    borderTopColor: accent,
                    animation: 'ztermDialogSpin 700ms linear infinite',
                  }}
                />
              ) : glyph}
            </div>
          <div
            style={{
              fontSize: '16px',
              fontWeight: 800,
              lineHeight: 1.35,
              color: 'var(--zterm-panel-text, #f5f7fb)',
            }}
          >
            {title}
          </div>
        </div>
        {message ? (
          <div
            data-testid="zterm-dialog-message"
            style={{
              marginTop: '14px',
              fontSize: '14px',
              lineHeight: 1.55,
              color: 'var(--zterm-panel-text, #f5f7fb)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {message}
          </div>
        ) : null}
        {detail ? (
          <div
            data-testid="zterm-dialog-detail"
            style={{
              marginTop: '10px',
              padding: '10px 12px',
              borderRadius: '10px',
              background: 'var(--zterm-panel-surface, rgba(255,255,255,0.04))',
              border: '1px solid var(--zterm-panel-border, rgba(255,255,255,0.10))',
              fontSize: '12px',
              lineHeight: 1.5,
              color: 'var(--zterm-panel-muted, #aab4c8)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {detail}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            marginTop: '18px',
          }}
        >
          {showCancel ? (
            <button
              type="button"
              aria-label={cancelLabel}
              data-testid="zterm-dialog-cancel"
              onClick={handleCancel}
              disabled={busy}
              style={{
                minHeight: '40px',
                padding: '0 16px',
                border: '1px solid var(--zterm-panel-border, rgba(255,255,255,0.16))',
                borderRadius: '12px',
                background: 'transparent',
                color: 'var(--zterm-panel-muted, #aab4c8)',
                fontSize: '14px',
                fontWeight: 800,
                opacity: busy ? 0.55 : 1,
              }}
            >
              {cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={confirmLabel}
            data-testid="zterm-dialog-confirm"
            onClick={handleConfirm}
            disabled={busy}
            style={{
              minHeight: '40px',
              padding: '0 18px',
              border: 'none',
              borderRadius: '12px',
              background: accent,
              color: 'var(--zterm-dialog-accent-text, #07110b)',
              fontSize: '14px',
              fontWeight: 900,
              opacity: busy ? 0.55 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
