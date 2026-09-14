// @vitest-environment jsdom

import React from 'react';
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
    expect(button?.className).toContain('ambient-control');
    expect(button?.className).toContain('amb-button');
    expect(button?.className).toContain('amb-chamfer');
  });

  it('renders AmbientInput as an input with ambient classes', () => {
    const { container } = render(<AmbientInput aria-label="ambient input" />);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('aria-label')).toBe('ambient input');
    expect(input?.className).toContain('ambient-control');
    expect(input?.className).toContain('amb-chamfer');
  });

  it('renders AmbientSelect as a select with ambient classes', () => {
    const { container } = render(<AmbientSelect aria-label="ambient select"><option>a</option></AmbientSelect>);
    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    expect(select?.getAttribute('aria-label')).toBe('ambient select');
    expect(select?.className).toContain('ambient-control');
    expect(select?.className).toContain('amb-select');
    expect(select?.className).toContain('amb-chamfer');
  });

  it('renders AmbientTextarea as a textarea with ambient classes', () => {
    const { container } = render(<AmbientTextarea aria-label="ambient textarea" />);
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute('aria-label')).toBe('ambient textarea');
    expect(textarea?.className).toContain('ambient-control');
    expect(textarea?.className).toContain('amb-chamfer');
  });
});
