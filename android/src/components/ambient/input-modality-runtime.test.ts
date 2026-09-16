// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createInputModalityRuntime } from './input-modality-runtime';

const INPUT_MODALITY_ATTRIBUTE = 'data-zterm-input-modality';

describe('ambient input modality runtime', () => {
  it('marks touch and pointer input before focus changes', () => {
    const root = document.documentElement;
    const cleanup = createInputModalityRuntime(root, document);

    expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('pointer');
    root.setAttribute(INPUT_MODALITY_ATTRIBUTE, 'keyboard');
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('pointer');

    cleanup();
  });

  it('enables keyboard focus only for tab navigation', () => {
    const root = document.documentElement;
    const cleanup = createInputModalityRuntime(root, document);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('pointer');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('keyboard');

    cleanup();
  });

  it('removes both listeners when the runtime is disposed', () => {
    const root = document.documentElement;
    const cleanup = createInputModalityRuntime(root, document);
    cleanup();

    root.setAttribute(INPUT_MODALITY_ATTRIBUTE, 'pointer');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('pointer');
  });
});
