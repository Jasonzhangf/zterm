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
        minHeight: '44px',
        borderRadius: '12px',
        border: '1px solid var(--zterm-settings-border, #d5dde6)',
        backgroundColor: 'var(--zterm-settings-field, #ffffff)',
        color: 'var(--zterm-settings-text)',
        fontSize: '15px',
        padding: '0 12px',
        boxSizing: 'border-box',
        minWidth: 0,
      };
  }
}

export const AmbientInput = forwardRef<HTMLInputElement, AmbientInputProps>(
  function AmbientInput({ variant = 'settings', style, className, ...props }, ref) {
    const ambientClass = ['ambient', 'ambient-control', 'amb-field', 'amb-chamfer', className].filter(Boolean).join(' ');
    return (
      <input
        ref={ref}
        className={ambientClass}
        style={{ ...resolveVariantStyle(variant), ...style }}
        {...props}
      />
    );
  },
);
