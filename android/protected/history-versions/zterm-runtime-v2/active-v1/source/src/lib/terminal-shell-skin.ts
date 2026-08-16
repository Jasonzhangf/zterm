import type { TerminalShellSkin } from './bridge-settings';

export type EffectiveTerminalShellSkin = 'light' | 'blue' | 'black';

export function resolveEffectiveTerminalShellSkin(
  skin: TerminalShellSkin | undefined,
  date: Date = new Date(),
): EffectiveTerminalShellSkin {
  if (skin === 'blue' || skin === 'black' || skin === 'light') {
    return skin;
  }
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= 6 && hour < 18 ? 'light' : 'black';
}

export function resolveNextTerminalShellBoundaryDelayMs(date: Date = new Date()) {
  const nextBoundary = new Date(date.getTime());
  nextBoundary.setSeconds(0, 0);
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour < 6) {
    nextBoundary.setHours(6, 0, 0, 0);
  } else if (hour < 18) {
    nextBoundary.setHours(18, 0, 0, 0);
  } else {
    nextBoundary.setDate(nextBoundary.getDate() + 1);
    nextBoundary.setHours(6, 0, 0, 0);
  }
  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

export function resolveTerminalRendererThemeForSkin(
  terminalThemeId: string | undefined,
  effectiveSkin: EffectiveTerminalShellSkin,
) {
  if (terminalThemeId && terminalThemeId !== 'default' && terminalThemeId !== 'classic-dark') {
    return terminalThemeId;
  }
  if (effectiveSkin === 'light') {
    return 'tabby-pencil-light';
  }
  return effectiveSkin === 'blue' ? 'tabby-cobalt2' : 'classic-dark';
}
