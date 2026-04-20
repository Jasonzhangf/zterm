export type LayoutProfile = 'phone-single' | 'wide-2col' | 'wide-3col';

export interface LayoutProfileInput {
  width: number;
  height?: number;
}

export interface LayoutResolution {
  profile: LayoutProfile;
  columns: number;
}

export function resolveLayoutProfile({ width }: LayoutProfileInput): LayoutResolution {
  if (width >= 1680) {
    return { profile: 'wide-3col', columns: 3 };
  }

  if (width >= 1040) {
    return { profile: 'wide-2col', columns: 2 };
  }

  return { profile: 'phone-single', columns: 1 };
}

export function clampVisibleColumns(requestedColumns: number, slotCount: number) {
  return Math.max(1, Math.min(requestedColumns, slotCount));
}
