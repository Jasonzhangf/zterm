import type { CSSProperties, ReactNode } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import { AmbientButton } from '../ambient';

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
      className="zterm-skeu-card"
      style={{
        borderRadius: '18px',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      <div>
        <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--zterm-settings-text)' }}>{title}</div>
        {description && (
          <div style={{ marginTop: '6px', fontSize: '13px', color: 'var(--zterm-settings-muted)' }}>{description}</div>
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
        color: 'var(--zterm-settings-text)',
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
    backgroundColor: 'var(--zterm-settings-field)',
    color: 'var(--zterm-settings-text)',
    fontSize: '15px',
    outline: 'none',
    ...extra,
  };
}

export function TagList({ tags, onRemove }: { tags: string[]; onRemove: (tag: string) => void }) {
  if (tags.length === 0) {
    return <div style={{ fontSize: '13px', color: 'var(--zterm-settings-muted)' }}>No tags yet</div>;
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
      {tags.map((tag) => (
        <AmbientButton
          key={tag}
          type="button"
          onClick={() => onRemove(tag)}
          style={{
            border: 'none',
            borderRadius: '999px',
            padding: '8px 12px',
            backgroundColor: 'var(--zterm-settings-field)',
            color: 'var(--zterm-settings-text)',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          #{tag} ×
        </AmbientButton>
      ))}
    </div>
  );
}
