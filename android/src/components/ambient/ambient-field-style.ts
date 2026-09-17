import type { CSSProperties } from 'react';

export function stripAmbientFieldMaterial(style: CSSProperties | undefined): CSSProperties {
  const geometryStyle = { ...style };
  delete geometryStyle.background;
  delete geometryStyle.backgroundColor;
  delete geometryStyle.border;
  delete geometryStyle.borderColor;
  delete geometryStyle.borderWidth;
  delete geometryStyle.borderStyle;
  delete geometryStyle.color;
  delete geometryStyle.boxShadow;
  delete geometryStyle.textShadow;
  return geometryStyle;
}
