/**
 * iOS IME context contracts.
 * Owns: typed IME state projection from Capacitor Keyboard/Keyboard plugin.
 * Forbidden: raw native objects, UI truth, domain state, terminal data stream.
 */
export type IosImeVisibility = 'visible' | 'hidden';

export interface IosImeContext {
  readonly visibility: IosImeVisibility;
  readonly keyboardHeight: number;
  readonly inputMode: 'text' | 'numeric' | 'tel' | 'url' | 'email';
}

export interface IosImeBridge {
  getKeyboardHeight(): number;
  addKeyboardListener(listener: (event: { isShowing: boolean; keyboardHeight: number }) => void): { remove(): void };
  getInputMode(): string;
}

/** Projects a Capacitor keyboard event into a typed IME context. */
export function projectImeContext(
  isShowing: boolean,
  keyboardHeight: number,
  inputMode: string,
): IosImeContext {
  if (!Number.isSafeInteger(keyboardHeight) || keyboardHeight < 0) {
    throw new TypeError(`keyboardHeight must be a non-negative safe integer: ${String(keyboardHeight)}`);
  }
  return {
    visibility: isShowing ? 'visible' : 'hidden',
    keyboardHeight,
    inputMode: normalizeInputMode(inputMode),
  };
}

function normalizeInputMode(value: string): IosImeContext['inputMode'] {
  const map: Record<string, IosImeContext['inputMode']> = {
    default: 'text',
    text: 'text',
    decimal: 'numeric',
    numeric: 'numeric',
    tel: 'tel',
    search: 'text',
    email: 'email',
    url: 'url',
  };
  return map[value] ?? 'text';
}

export function createIosImeManager(bridge: IosImeBridge) {
  return {
    getCurrentContext(): IosImeContext {
      return projectImeContext(bridge.getKeyboardHeight() > 0, bridge.getKeyboardHeight(), bridge.getInputMode());
    },
    subscribe(listener: (ctx: IosImeContext) => void): { remove(): void } {
      return bridge.addKeyboardListener(({ isShowing, keyboardHeight }) => {
        listener(projectImeContext(isShowing, keyboardHeight, bridge.getInputMode()));
      });
    },
  };
}
