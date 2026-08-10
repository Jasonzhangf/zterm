// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowGroupLayout, resolveWindowGroupLayoutPlan } from './WindowGroupLayout';

describe('WindowGroupLayout', () => {
  afterEach(() => {
    cleanup();
  });

  it('uses a bottom primary pane in portrait and a side rail in landscape', () => {
    expect(resolveWindowGroupLayoutPlan(4, false)).toEqual({
      primaryAxis: 'column',
      secondaryAxis: 'row',
      primaryFlex: 3,
      secondaryFlex: 1,
    });
    expect(resolveWindowGroupLayoutPlan(4, true)).toEqual({
      primaryAxis: 'row',
      secondaryAxis: 'column',
      primaryFlex: 3,
      secondaryFlex: 1,
    });
  });

  it('keeps every secondary window as its own selectable child container', () => {
    const onPrimaryItemChange = vi.fn();
    render(
      <WindowGroupLayout
        landscape
        testId="window-group"
        primaryItemId="a"
        onPrimaryItemChange={onPrimaryItemChange}
        items={[
          { id: 'a', node: <div data-testid="window-a">a</div> },
          { id: 'b', testId: 'child-b', roleLabel: 'switch b', node: <div data-testid="window-b">b</div> },
          { id: 'c', testId: 'child-c', roleLabel: 'switch c', node: <div data-testid="window-c">c</div> },
        ]}
      />,
    );

    expect(screen.getByTestId('window-group').getAttribute('data-window-group-secondary-placement')).toBe('after');
    fireEvent.click(screen.getByTestId('child-b'));
    expect(onPrimaryItemChange).toHaveBeenCalledWith('b');
    expect(screen.getByTestId('window-a')).toBeTruthy();
    expect(screen.getByTestId('window-b')).toBeTruthy();
    expect(screen.getByTestId('window-c')).toBeTruthy();
  });

  it('can place the secondary rail before the primary pane for top preview rows', () => {
    render(
      <WindowGroupLayout
        testId="window-group"
        landscape={false}
        primaryItemId="a"
        secondaryPlacement="before"
        items={[
          { id: 'a', node: <div data-testid="window-a">a</div> },
          { id: 'b', testId: 'child-b', node: <div data-testid="window-b">b</div> },
        ]}
      />,
    );

    const root = screen.getByTestId('window-group');
    expect(root.getAttribute('data-window-group-secondary-placement')).toBe('before');
    expect(root.firstElementChild?.contains(screen.getByTestId('child-b'))).toBe(true);
  });

  it('supports a non-wrapping, horizontally scrollable top rail', () => {
    render(
      <WindowGroupLayout
        testId="window-group-scroll"
        landscape={false}
        primaryItemId="a"
        secondaryPlacement="before"
        secondaryWrap="nowrap"
        secondaryItemFlex="0 0 min(30%, 160px)"
        secondaryOverflowX="auto"
        items={[
          { id: 'a', node: <div data-testid="window-a">a</div> },
          { id: 'b', node: <div data-testid="window-b">b</div> },
          { id: 'c', node: <div data-testid="window-c">c</div> },
          { id: 'd', node: <div data-testid="window-d">d</div> },
        ]}
      />,
    );

    const root = screen.getByTestId('window-group-scroll');
    const rail = root.firstElementChild;
    expect(rail?.getAttribute('style')).toContain('flex-wrap: nowrap');
    expect(rail?.getAttribute('style')).toContain('overflow-x: auto');
    expect(root.firstElementChild?.contains(screen.getByTestId('window-b'))).toBe(true);
  });
});
