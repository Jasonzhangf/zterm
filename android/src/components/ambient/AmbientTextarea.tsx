import { forwardRef, type CSSProperties, type TextareaHTMLAttributes } from 'react';
import { stripAmbientFieldMaterial } from './ambient-field-style';

export type AmbientTextareaVariant = 'settings' | 'settings-multiline';

export interface AmbientTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: AmbientTextareaVariant;
}

function resolveVariantStyle(variant: AmbientTextareaVariant): CSSProperties {
  switch (variant) {
    case 'settings':
      return {
        width: '100%',
        minHeight: '48px',
        borderRadius: '12px',
        border: '1px solid var(--zterm-skeu-edge-dark)',
        backgroundColor: 'var(--zterm-skeu-well)',
        color: 'var(--zterm-skeu-text)',
        boxShadow: 'var(--zterm-skeu-inset-shadow)',
        textShadow: 'none',
        fontSize: '15px',
        padding: '10px 12px',
        boxSizing: 'border-box',
        minWidth: 0,
      };
    case 'settings-multiline':
      return {
        width: '100%',
        minHeight: '84px',
        borderRadius: '12px',
        border: '1px solid var(--zterm-skeu-edge-dark)',
        backgroundColor: 'var(--zterm-skeu-well)',
        color: 'var(--zterm-skeu-text)',
        boxShadow: 'var(--zterm-skeu-inset-shadow)',
        textShadow: 'none',
        fontSize: '15px',
        padding: '10px 12px',
        boxSizing: 'border-box',
        minWidth: 0,
        resize: 'vertical',
      };
  }
}

export const AmbientTextarea = forwardRef<HTMLTextAreaElement, AmbientTextareaProps>(
  function AmbientTextarea({ variant = 'settings', style, className, ...props }, ref) {
    const ambientClass = ['ambient', 'ambient-control', 'amb-field', 'amb-chamfer', className].filter(Boolean).join(' ');
    const materialStyle = resolveVariantStyle(variant);
    return (
      <textarea
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
