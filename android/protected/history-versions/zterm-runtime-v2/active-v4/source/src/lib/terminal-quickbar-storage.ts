/**
 * TerminalQuickBar 本地持久化 owner（client.input_runtime）。
 * 剪贴板历史 / 浮钮位置只经本模块读写 localStorage；组件禁止直写 raw storage key。
 */

export const CLIPBOARD_HISTORY_STORAGE_KEY = 'zterm:clipboard-history';
export const MAX_CLIPBOARD_HISTORY = 100;
export const FLOATING_BUBBLE_POSITION_STORAGE_KEY = 'zterm:floating-bubble-position';

export interface FloatingBubblePosition {
  x: number | null;
  y: number | null;
}

export function normalizeClipboardHistory(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item): item is string => typeof item === 'string')
    .filter((item) => item.length > 0)
    .slice(0, MAX_CLIPBOARD_HISTORY);
}

export function dedupeClipboardHistory(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.length > 0))).slice(
    0,
    MAX_CLIPBOARD_HISTORY,
  );
}

export function readStoredClipboardHistory(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const stored = localStorage.getItem(CLIPBOARD_HISTORY_STORAGE_KEY);
    if (!stored) {
      return [];
    }
    return normalizeClipboardHistory(JSON.parse(stored));
  } catch (error) {
    console.error(
      '[TerminalQuickBar] Failed to load clipboard history:',
      error,
    );
    return [];
  }
}

export function writeStoredClipboardHistory(items: string[]) {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(
    CLIPBOARD_HISTORY_STORAGE_KEY,
    JSON.stringify(dedupeClipboardHistory(items)),
  );
}

export function readStoredBubblePosition(): FloatingBubblePosition {
  if (typeof window === 'undefined') {
    return { x: null, y: null };
  }
  try {
    const raw = localStorage.getItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY);
    if (!raw) {
      return { x: null, y: null };
    }
    const parsed = JSON.parse(raw) as Partial<{ x: number; y: number }>;
    const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : null;
    const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null;
    return { x, y };
  } catch (error) {
    console.warn(
      '[TerminalQuickBar] Failed to read stored floating bubble position:',
      error,
    );
    return { x: null, y: null };
  }
}

export function writeStoredBubblePosition(position: FloatingBubblePosition) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (position.x === null || position.y === null) {
      localStorage.removeItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      FLOATING_BUBBLE_POSITION_STORAGE_KEY,
      JSON.stringify(position),
    );
  } catch (error) {
    console.error(
      '[TerminalQuickBar] Failed to persist floating bubble position:',
      error,
    );
  }
}
