import { registerPlugin } from '@capacitor/core';

export interface ImeAnchorPlugin {
  show(): Promise<Record<string, unknown>>;
  hide(): Promise<void>;
  blur(): Promise<void>;
  getState(): Promise<Record<string, unknown>>;
  debugEmitInput(options: { text: string }): Promise<Record<string, unknown>>;
  addListener(
    eventName: 'input',
    listenerFunc: (event: { text: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: 'backspace',
    listenerFunc: (event: { count?: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: 'keyboardState',
    listenerFunc: (event: { visible?: boolean; height?: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const ImeAnchor = registerPlugin<ImeAnchorPlugin>('ImeAnchor');
