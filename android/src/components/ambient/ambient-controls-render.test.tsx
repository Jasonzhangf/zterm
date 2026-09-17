// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AmbientButton,
  AmbientInput,
  AmbientSelect,
  AmbientTextarea,
} from '.';

describe('ambient shared controls render owner DOM', () => {
  it('renders AmbientButton as a button with ambient classes', () => {
    const { container } = render(<AmbientButton aria-label="ambient button">保存</AmbientButton>);
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('ambient button');
    expect(button?.className).toContain('ambient');
    expect(button?.className).toContain('ambient-control');
    expect(button?.className).toContain('amb-button');
    expect(button?.className).toContain('amb-chamfer');
  });

  it('lets explicit caller geometry win over variant minimums', () => {
    const { container } = render(
      <>
        <AmbientButton aria-label="checkbox" style={{ width: '18px', height: '18px' }} />
        <AmbientButton aria-label="icon" style={{ width: '34px', height: '34px' }} />
        <AmbientButton aria-label="default" />
      </>,
    );
    const [checkbox, icon, defaultButton] = Array.from(container.querySelectorAll('button'));
    for (const button of [checkbox, icon]) {
      expect(button.style.minWidth).toBe('0px');
      expect(button.style.minHeight).toBe('0px');
    }
    expect(defaultButton.style.minWidth).toBe('44px');
  });

  it('marks transparent button variants as flat so material hover states do not fill them', () => {
    const { container } = render(
      <>
        <AmbientButton aria-label="saved open" variant="saved-open" />
        <AmbientButton aria-label="transparent" style={{ background: 'transparent' }} />
        <AmbientButton aria-label="material" />
      </>,
    );
    const [savedOpen, transparent, material] = Array.from(container.querySelectorAll('button'));
    expect(savedOpen.getAttribute('data-amb-flat')).toBe('true');
    expect(transparent.getAttribute('data-amb-flat')).toBe('true');
    expect(material.hasAttribute('data-amb-flat')).toBe(false);
  });

  it('renders AmbientInput as an input with ambient classes', () => {
    const { container } = render(<AmbientInput aria-label="ambient input" />);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('aria-label')).toBe('ambient input');
    expect(input?.className).toContain('ambient');
    expect(input?.className).toContain('ambient-control');
    expect(input?.className).toContain('amb-chamfer');
  });

  it('keeps checkbox geometry fixed instead of stretching to the field width', () => {
    const { container } = render(
      <>
        <AmbientInput aria-label="checkbox" type="checkbox" />
        <AmbientInput aria-label="text field" />
      </>,
    );
    const [checkbox, textField] = Array.from(container.querySelectorAll('input'));
    expect(checkbox.style.width).toBe('18px');
    expect(checkbox.style.height).toBe('18px');
    expect(checkbox.style.minWidth).toBe('18px');
    expect(checkbox.style.minHeight).toBe('18px');
    expect(checkbox.style.padding).toBe('0px');
    expect(checkbox.style.margin).toBe('0px');
    expect(checkbox.style.flex).toBe('0 0 18px');
    expect(textField.style.width).toBe('100%');
    expect(textField.style.minHeight).toBe('44px');
  });

  it('keeps caller geometry while the shared field material owns visual properties', () => {
    const { container } = render(
      <>
        <AmbientInput
          aria-label="input"
          style={{
            width: '72%',
            background: 'rgb(1, 2, 3)',
            border: '1px solid red',
            borderColor: 'red',
            borderWidth: '3px',
            borderStyle: 'dashed',
            color: 'red',
            boxShadow: 'none',
            textShadow: 'none',
          }}
        />
        <AmbientSelect
          aria-label="select"
          style={{
            minHeight: '38px',
            background: 'rgb(1, 2, 3)',
            border: '1px solid red',
            borderColor: 'red',
            borderWidth: '3px',
            borderStyle: 'dashed',
            color: 'red',
            boxShadow: 'none',
            textShadow: 'none',
          }}
        >
          <option>a</option>
        </AmbientSelect>
        <AmbientTextarea
          aria-label="textarea"
          style={{
            minHeight: '76px',
            background: 'rgb(1, 2, 3)',
            border: '1px solid red',
            borderColor: 'red',
            borderWidth: '3px',
            borderStyle: 'dashed',
            color: 'red',
            boxShadow: 'none',
            textShadow: 'none',
          }}
        />
      </>,
    );

    const input = container.querySelector('input');
    const select = container.querySelector('select');
    const textarea = container.querySelector('textarea');
    expect(input?.style.width).toBe('72%');
    expect(select?.style.minHeight).toBe('38px');
    expect(textarea?.style.minHeight).toBe('76px');
    for (const control of [input, select, textarea]) {
      expect(control?.style.border).toContain('var(--amb-control-border)');
      expect(control?.style.backgroundColor).toBe('var(--amb-control-bg)');
      expect(control?.style.color).toBe('var(--amb-control-text)');
      expect(control?.style.boxShadow).toContain('var(--amb-control-inset)');
      expect(control?.style.textShadow).toContain('var(--amb-control-text-shadow');
    }
  });

  it('renders AmbientSelect as a select with ambient classes', () => {
    const { container } = render(<AmbientSelect aria-label="ambient select"><option>a</option></AmbientSelect>);
    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    expect(select?.getAttribute('aria-label')).toBe('ambient select');
    expect(select?.className).toContain('ambient');
    expect(select?.className).toContain('ambient-control');
    expect(select?.className).toContain('amb-select');
    expect(select?.className).toContain('amb-chamfer');
  });

  it('renders AmbientTextarea as a textarea with ambient classes', () => {
    const { container } = render(<AmbientTextarea aria-label="ambient textarea" />);
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute('aria-label')).toBe('ambient textarea');
    expect(textarea?.className).toContain('ambient');
    expect(textarea?.className).toContain('ambient-control');
    expect(textarea?.className).toContain('amb-chamfer');
  });
});
