const QUICKBAR_INTERACTIVE_SELECTOR =
  '[data-quickbar-allow-pointer="true"],input,textarea,button,select,label';

export function shouldAllowQuickBarShellPointerEvent(target: HTMLElement | null) {
  return Boolean(target?.closest(QUICKBAR_INTERACTIVE_SELECTOR));
}
