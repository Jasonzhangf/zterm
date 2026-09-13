import { forwardRef, type CSSProperties, type InputHTMLAttributes } from 'react';

export type AmbientInputVariant = 'settings';

export interface AmbientInputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: AmbientInputVariant;
}

function resolveVariantStyle(variant: AmbientInputVariant): CSSProperties {
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
  }
}

export const AmbientInput = forwardRef<HTMLInputElement, AmbientInputProps>(
  function AmbientInput({ variant = 'settings', style, ...props }, ref) {
    return (
      <input
        ref={ref}
        style={{ ...resolveVariantStyle(variant), ...style }}
        {...props}
      />
    );
  },
);
