// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shouldAllowQuickBarShellPointerEvent } from './terminal-quickbar-shell-guards';

function makeElement(markup: string) {
  const host = document.createElement('div');
  host.innerHTML = markup.trim();
  return host.firstElementChild as HTMLElement;
}

describe('terminal-quickbar-shell-guards', () => {
  it('allows only quickbar-owned interactive targets through the shell guard', () => {
    expect(shouldAllowQuickBarShellPointerEvent(makeElement('<button>ok</button>'))).toBe(true);
    expect(shouldAllowQuickBarShellPointerEvent(makeElement('<input />'))).toBe(true);
    expect(shouldAllowQuickBarShellPointerEvent(makeElement('<label>ok</label>'))).toBe(true);
    expect(
      shouldAllowQuickBarShellPointerEvent(
        makeElement('<div data-quickbar-allow-pointer="true"></div>'),
      ),
    ).toBe(true);
    expect(shouldAllowQuickBarShellPointerEvent(makeElement('<div></div>'))).toBe(false);
  });
});
