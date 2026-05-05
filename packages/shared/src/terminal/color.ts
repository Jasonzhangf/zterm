export const DEFAULT_TERMINAL_COLOR = 256;
export const TRUECOLOR_COLOR_FLAG = 0x01000000;
export const TRUECOLOR_RGB_MASK = 0x00ffffff;

export function encodePackedTruecolorColor(red: number, green: number, blue: number) {
  const r = Math.max(0, Math.min(255, Math.floor(red || 0)));
  const g = Math.max(0, Math.min(255, Math.floor(green || 0)));
  const b = Math.max(0, Math.min(255, Math.floor(blue || 0)));
  return TRUECOLOR_COLOR_FLAG | (r << 16) | (g << 8) | b;
}

export function isPackedTruecolorColor(value: number) {
  return Number.isInteger(value) && value >= TRUECOLOR_COLOR_FLAG && value <= (TRUECOLOR_COLOR_FLAG | TRUECOLOR_RGB_MASK);
}

export function decodePackedTruecolorColor(value: number): [number, number, number] | null {
  if (!isPackedTruecolorColor(value)) {
    return null;
  }
  const rgb = value & TRUECOLOR_RGB_MASK;
  return [
    (rgb >> 16) & 0xff,
    (rgb >> 8) & 0xff,
    rgb & 0xff,
  ];
}

export function packedTruecolorToCss(value: number) {
  const rgb = decodePackedTruecolorColor(value);
  if (!rgb) {
    return null;
  }
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}
