export type IosImeVisibility = 'visible' | 'hidden';
export interface IosImeContext { readonly visibility: IosImeVisibility; readonly keyboardHeight: number; readonly inputMode: 'text' | 'numeric' | 'tel' | 'url' | 'email' }
export interface IosImeBridge { getKeyboardHeight(): number; addKeyboardListener(listener: (event: { isShowing: boolean; keyboardHeight: number }) => void): { remove(): void }; getInputMode(): string }
export function projectImeContext(isShowing: boolean, keyboardHeight: number, inputMode: string): IosImeContext {
  if (!Number.isSafeInteger(keyboardHeight) || keyboardHeight < 0) throw new TypeError(`keyboardHeight must be a non-negative safe integer: ${String(keyboardHeight)}`);
  const mode: Record<string, IosImeContext['inputMode']> = { default: 'text', text: 'text', decimal: 'numeric', numeric: 'numeric', tel: 'tel', search: 'text', email: 'email', url: 'url' };
  return { visibility: isShowing ? 'visible' : 'hidden', keyboardHeight, inputMode: mode[inputMode] ?? 'text' };
}
export function createIosImeManager(bridge: IosImeBridge) {
  return {
    getCurrentContext: () => projectImeContext(bridge.getKeyboardHeight() > 0, bridge.getKeyboardHeight(), bridge.getInputMode()),
    subscribe: (listener: (ctx: IosImeContext) => void) => bridge.addKeyboardListener(({ isShowing, keyboardHeight }) => listener(projectImeContext(isShowing, keyboardHeight, bridge.getInputMode()))),
  };
}
