// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindowGroupLayout, resolveWindowGroupLayoutPlan } from './WindowGroupLayout';

describe('WindowGroupLayout', () => {
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
        primaryItemId="a"
        onPrimaryItemChange={onPrimaryItemChange}
        items={[
          { id: 'a', node: <div data-testid="window-a">a</div> },
          { id: 'b', testId: 'child-b', roleLabel: 'switch b', node: <div data-testid="window-b">b</div> },
          { id: 'c', testId: 'child-c', roleLabel: 'switch c', node: <div data-testid="window-c">c</div> },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId('child-b'));
    expect(onPrimaryItemChange).toHaveBeenCalledWith('b');
    expect(screen.getByTestId('window-a')).toBeTruthy();
    expect(screen.getByTestId('window-b')).toBeTruthy();
    expect(screen.getByTestId('window-c')).toBeTruthy();
  });
});
