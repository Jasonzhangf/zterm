import { forwardRef, type CSSProperties, type TextareaHTMLAttributes } from 'react';

export type AmbientTextareaVariant = 'settings' | 'settings-multiline';

export interface AmbientTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: AmbientTextareaVariant;
}

function resolveVariantStyle(variant: AmbientTextareaVariant): CSSProperties {
  switch (variant) {
    case 'settings':
      return {
        width: '100%',
        minHeight: '56px',
        borderRadius: '20px',
        border: '1px solid var(--zterm-settings-border, #d5dde6)',
        backgroundColor: 'var(--zterm-settings-field, #ffffff)',
        color: 'var(--zterm-settings-text)',
        fontSize: '18px',
        padding: '0 clamp(12px, 3vw, 22px)',
        boxSizing: 'border-box',
        minWidth: 0,
      };
    case 'settings-multiline':
      return {
        width: '100%',
        minHeight: '96px',
        borderRadius: '20px',
        border: '1px solid var(--zterm-settings-border, #d5dde6)',
        backgroundColor: 'var(--zterm-settings-field, #ffffff)',
        color: 'var(--zterm-settings-text)',
        fontSize: '18px',
        padding: '0 clamp(12px, 3vw, 22px)',
        boxSizing: 'border-box',
        minWidth: 0,
        resize: 'vertical',
      };
  }
}

export const AmbientTextarea = forwardRef<HTMLTextAreaElement, AmbientTextareaProps>(
  function AmbientTextarea({ variant = 'settings', style, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        style={{ ...resolveVariantStyle(variant), ...style }}
        {...props}
      />
    );
  },
);
