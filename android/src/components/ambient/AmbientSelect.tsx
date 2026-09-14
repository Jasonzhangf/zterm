import { forwardRef, type CSSProperties, type SelectHTMLAttributes } from 'react';

export type AmbientSelectVariant = 'settings';

export interface AmbientSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  variant?: AmbientSelectVariant;
}

function resolveVariantStyle(variant: AmbientSelectVariant): CSSProperties {
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

export const AmbientSelect = forwardRef<HTMLSelectElement, AmbientSelectProps>(
  function AmbientSelect({ variant = 'settings', style, className, ...props }, ref) {
    const ambientClass = ['ambient-control', 'amb-select', 'amb-chamfer', className].filter(Boolean).join(' ');
    return (
      <select
        ref={ref}
        className={ambientClass}
        style={{ ...resolveVariantStyle(variant), ...style }}
        {...props}
      />
    );
  },
);
