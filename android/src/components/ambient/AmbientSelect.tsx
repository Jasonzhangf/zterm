import { forwardRef, type CSSProperties, type SelectHTMLAttributes } from 'react';
import { stripAmbientFieldMaterial } from './ambient-field-style';

export type AmbientSelectVariant = 'settings';

export interface AmbientSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  variant?: AmbientSelectVariant;
}

function resolveVariantStyle(variant: AmbientSelectVariant): CSSProperties {
  switch (variant) {
    case 'settings':
      return {
        width: '100%',
        minHeight: '44px',
        borderRadius: '12px',
        border: '1px solid var(--amb-control-border)',
        backgroundColor: 'var(--amb-control-bg)',
        color: 'var(--amb-control-text)',
        boxShadow: 'var(--amb-control-inset)',
        textShadow: 'var(--amb-control-text-shadow, none)',
        fontSize: '15px',
        padding: '0 12px',
        boxSizing: 'border-box',
        minWidth: 0,
      };
  }
}

export const AmbientSelect = forwardRef<HTMLSelectElement, AmbientSelectProps>(
  function AmbientSelect({ variant = 'settings', style, className, ...props }, ref) {
    const ambientClass = ['ambient', 'ambient-control', 'amb-select', 'amb-chamfer', className].filter(Boolean).join(' ');
    const materialStyle = resolveVariantStyle(variant);
    return (
      <select
        ref={ref}
        className={ambientClass}
        style={{
          ...materialStyle,
          ...stripAmbientFieldMaterial(style),
        }}
        {...props}
      />
    );
  },
);
