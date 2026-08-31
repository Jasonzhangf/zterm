import { useEffect, useRef, useState, type ReactNode } from 'react';

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

function ToneGlyph({ tone }: { tone: ZtermDialogTone }) {
  const paths: Record<ZtermDialogTone, ReactNode> = {
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6" />
        <path d="M12 7.5h.01" />
      </>
    ),
    success: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12.5 2.5 2.5L16 9.5" />
      </>
    ),
    warning: (
      <>
        <path d="m10.28 3.86-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.72-3.14l-8-14a2 2 0 0 0-3.44 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    ),
    error: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m15 9-6 6" />
        <path d="m9 9 6 6" />
      </>
    ),
  };

  return (
    <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
      {paths[tone]}
    </svg>
  );
}

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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<Element | null>(null);
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!open || !autoDismissMs || autoDismissMs <= 0) {
      return;
    }
    const handle = window.setTimeout(() => {
      onConfirm?.();
    }, autoDismissMs);
    return () => window.clearTimeout(handle);
  }, [autoDismissMs, onConfirm, open]);

  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement;
      setClosing(false);
      setRendered(true);
      return;
    }
    if (!rendered) {
      return;
    }
    setClosing(true);
    const handle = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, 150);
    return () => window.clearTimeout(handle);
  }, [open, rendered]);

  useEffect(() => {
    if (!open || !rendered) {
      return;
    }
    panelRef.current?.focus({ preventScroll: true });
    const previousTrigger = triggerRef.current;
    return () => {
      if (previousTrigger instanceof HTMLElement) {
        previousTrigger.focus({ preventScroll: true });
      }
    };
  }, [open, rendered]);

  useEffect(() => {
    if (!open || !rendered) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) {
          onCancel?.();
        }
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && (active === panel || active === first)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [busy, onCancel, open, rendered]);

  if (!rendered) {
    return null;
  }

  const accent = toneAccent[tone];
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
    <div
        data-testid="zterm-dialog"
        data-tone={tone}
        data-state={closing ? 'closing' : 'open'}
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
          animation: closing
            ? 'ztermDialogExit 150ms ease-in forwards'
            : 'ztermDialogFade 160ms ease-out',
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
          ref={panelRef}
          tabIndex={-1}
          style={{
            width: 'min(100%, 360px)',
            borderRadius: '18px',
            padding: '20px',
            boxSizing: 'border-box',
            background: 'var(--zterm-panel-bg, #101622)',
            color: 'var(--zterm-panel-text, #f5f7fb)',
            border: '1px solid var(--zterm-panel-border, rgba(255,255,255,0.14))',
            boxShadow: '0 24px 60px rgba(0,0,0,0.44)',
            animation: closing
              ? 'ztermDialogPanelExit 150ms ease-in forwards'
              : 'ztermDialogPop 220ms cubic-bezier(0.22, 1, 0.36, 1)',
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
              ) : <ToneGlyph tone={tone} />}
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
  );
}
