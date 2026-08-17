import type { CSSProperties, ReactNode } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';

export function ConnectionSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        borderRadius: '28px',
        backgroundColor: mobileTheme.colors.lightCard,
        border: `1px solid ${mobileTheme.colors.lightBorder}`,
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        boxShadow: mobileTheme.shadow.soft,
      }}
    >
      <div>
        <div style={{ fontSize: '18px', fontWeight: 800, color: mobileTheme.colors.lightText }}>{title}</div>
        {description && (
          <div style={{ marginTop: '6px', fontSize: '13px', color: mobileTheme.colors.lightMuted }}>{description}</div>
        )}
      </div>
      {children}
    </section>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        marginBottom: '8px',
        fontSize: '13px',
        fontWeight: 700,
        color: mobileTheme.colors.lightText,
      }}
    >
      {children}
    </label>
  );
}

export function inputStyle(extra?: CSSProperties): CSSProperties {
  return {
    width: '100%',
    minHeight: '52px',
    padding: '14px 16px',
    borderRadius: '18px',
    border: `1px solid ${mobileTheme.colors.lightBorder}`,
    backgroundColor: '#f8fbfd',
    color: mobileTheme.colors.lightText,
    fontSize: '15px',
    outline: 'none',
    ...extra,
  };
}

export function segmentedButtonStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    minHeight: '48px',
    borderRadius: '16px',
    border: 'none',
    backgroundColor: active ? mobileTheme.colors.shell : '#eef3f8',
    color: active ? mobileTheme.colors.textPrimary : mobileTheme.colors.lightMuted,
    fontWeight: 700,
    cursor: 'pointer',
  };
}

export function TagList({ tags, onRemove }: { tags: string[]; onRemove: (tag: string) => void }) {
  if (tags.length === 0) {
    return <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted }}>No tags yet</div>;
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => onRemove(tag)}
          style={{
            border: 'none',
            borderRadius: '999px',
            padding: '8px 12px',
            backgroundColor: mobileTheme.colors.lightAccent,
            color: mobileTheme.colors.lightText,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          #{tag} ×
        </button>
      ))}
    </div>
  );
}
