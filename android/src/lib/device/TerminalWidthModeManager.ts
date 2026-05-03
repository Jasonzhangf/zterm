import type { TerminalWidthMode } from '../types';

type Listener = (mode: TerminalWidthMode) => void;

const STORAGE_KEY = 'terminal-width-mode';

export class TerminalWidthModeManager {
  private currentMode: TerminalWidthMode;
  private listeners: Set<Listener> = new Set();

  constructor(defaultMode: TerminalWidthMode = 'adaptive-phone') {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'adaptive-phone' || stored === 'mirror-fixed') {
      this.currentMode = stored;
    } else {
      this.currentMode = defaultMode;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.currentMode);
    }
  }

  getMode(): TerminalWidthMode {
    return this.currentMode;
  }

  setMode(mode: TerminalWidthMode): void {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    localStorage.setItem(STORAGE_KEY, mode);
    this.notify();
  }
}
