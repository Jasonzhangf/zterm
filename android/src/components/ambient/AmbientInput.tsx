import { forwardRef, type CSSProperties, type InputHTMLAttributes } from 'react';
import { stripAmbientFieldMaterial } from './ambient-field-style';

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

function resolveCheckboxStyle(): CSSProperties {
  return {
    width: '18px',
    height: '18px',
    minWidth: '18px',
    minHeight: '18px',
    padding: 0,
    margin: 0,
    flex: '0 0 18px',
  };
}

export const AmbientInput = forwardRef<HTMLInputElement, AmbientInputProps>(
  function AmbientInput({ variant = 'settings', style, className, ...props }, ref) {
    const ambientClass = ['ambient', 'ambient-control', 'amb-field', 'amb-chamfer', className].filter(Boolean).join(' ');
    const materialStyle = resolveVariantStyle(variant);
    const geometryStyle = props.type === 'checkbox' ? resolveCheckboxStyle() : null;
    return (
      <input
        ref={ref}
        className={ambientClass}
        style={{
          ...materialStyle,
          ...geometryStyle,
          ...stripAmbientFieldMaterial(style),
        }}
        {...props}
      />
    );
  },
);
