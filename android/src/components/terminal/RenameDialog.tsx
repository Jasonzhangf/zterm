import { useEffect, useRef, useState } from 'react';

export interface RenameDialogProps {
  open: boolean;
  title: string;
  initialValue: string;
  confirmLabel?: string;
  inputLabel?: string;
  onCancel: () => void;
  onSubmit: (nextValue: string) => void;
}

export function RenameDialog({
  open,
  title,
  initialValue,
  confirmLabel = '确认重命名',
  inputLabel = '新的名称',
  onCancel,
  onSubmit,
}: RenameDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (!open) {
      return;
    }
    setValue(initialValue);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialValue, open]);

  if (!open) {
    return null;
  }

  const submit = () => {
    const next = value.trim();
    if (!next) {
      return;
    }
    onSubmit(next);
  };

  return (
    <div
      data-testid="rename-dialog"
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '18px',
        backgroundColor: 'rgba(8, 12, 20, 0.62)',
        backdropFilter: 'blur(6px)',
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: 'min(100%, 360px)',
          borderRadius: '16px',
          padding: '18px',
          boxSizing: 'border-box',
          background: 'var(--zterm-panel-bg, #101622)',
          color: 'var(--zterm-panel-text, #f5f7fb)',
          border: '1px solid var(--zterm-panel-border, rgba(255,255,255,0.14))',
          boxShadow: '0 24px 60px rgba(0,0,0,0.44)',
        }}
      >
        <div style={{ fontSize: '16px', fontWeight: 800 }}>{title}</div>
        <input
          ref={inputRef}
          aria-label={inputLabel}
          data-testid="rename-dialog-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          spellCheck={false}
          autoComplete="off"
          style={{
            width: '100%',
            minHeight: '46px',
            marginTop: '14px',
            boxSizing: 'border-box',
            padding: '0 12px',
            borderRadius: '12px',
            border: '1px solid var(--zterm-panel-border, rgba(255,255,255,0.18))',
            background: 'var(--zterm-input-bg, #18202f)',
            color: 'var(--zterm-panel-text, #f5f7fb)',
            fontSize: '15px',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
          <button
            type="button"
            aria-label="取消重命名"
            onClick={onCancel}
            style={{
              minHeight: '40px',
              padding: '0 16px',
              border: '1px solid var(--zterm-panel-border, rgba(255,255,255,0.16))',
              borderRadius: '12px',
              background: 'transparent',
              color: 'var(--zterm-panel-muted, #aab4c8)',
              fontSize: '14px',
              fontWeight: 800,
            }}
          >
            取消
          </button>
          <button
            type="button"
            aria-label={confirmLabel}
            disabled={!value.trim()}
            onClick={submit}
            style={{
              minHeight: '40px',
              padding: '0 18px',
              border: 'none',
              borderRadius: '12px',
              background: 'var(--zterm-accent, #1fd67a)',
              color: '#07110b',
              fontSize: '14px',
              fontWeight: 900,
              opacity: value.trim() ? 1 : 0.45,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
