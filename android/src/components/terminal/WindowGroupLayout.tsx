import type { CSSProperties, ReactNode } from 'react';

export type WindowGroupLayoutAxis = 'row' | 'column';

export interface WindowGroupLayoutPlan {
  primaryAxis: WindowGroupLayoutAxis;
  secondaryAxis: WindowGroupLayoutAxis;
  primaryFlex: number;
  secondaryFlex: number;
}

export function resolveWindowGroupLayoutPlan(
  itemCount: number,
  landscape: boolean,
): WindowGroupLayoutPlan {
  if (itemCount <= 1) {
    return {
      primaryAxis: 'row',
      secondaryAxis: 'row',
      primaryFlex: 1,
      secondaryFlex: 0,
    };
  }
  if (landscape) {
    return {
      primaryAxis: 'row',
      secondaryAxis: 'column',
      primaryFlex: 3,
      secondaryFlex: 1,
    };
  }
  return {
    primaryAxis: 'column',
    secondaryAxis: 'row',
    primaryFlex: 3,
    secondaryFlex: 1,
  };
}

export interface WindowGroupLayoutItem {
  id: string;
  title?: ReactNode;
  meta?: ReactNode;
  node: ReactNode;
  onPress?: () => void;
  testId?: string;
  roleLabel?: string;
}

export interface WindowGroupLayoutProps {
  items: WindowGroupLayoutItem[];
  landscape: boolean;
  primaryItemId?: string | null;
  onPrimaryItemChange?: (itemId: string) => void;
  secondaryPlacement?: 'before' | 'after';
  secondaryWrap?: 'wrap' | 'nowrap';
  secondaryItemFlex?: CSSProperties['flex'];
  secondaryOverflowX?: CSSProperties['overflowX'];
  className?: string;
  testId?: string;
  style?: CSSProperties;
  primaryLabel?: ReactNode;
  secondaryLabel?: ReactNode;
}

export function WindowGroupLayout({
  items,
  landscape,
  primaryItemId = null,
  onPrimaryItemChange,
  secondaryPlacement = 'after',
  secondaryWrap = 'wrap',
  secondaryItemFlex,
  secondaryOverflowX,
  className,
  testId,
  style,
  primaryLabel,
  secondaryLabel,
}: WindowGroupLayoutProps) {
  const plan = resolveWindowGroupLayoutPlan(items.length, landscape);
  const primaryItem = items.find((item) => item.id === primaryItemId) || items[0] || null;
  const secondaryItems = primaryItem ? items.filter((item) => item.id !== primaryItem.id) : [];

  if (!primaryItem) {
    return null;
  }

  const rootStyle: CSSProperties = {
    display: 'flex',
    flexDirection: plan.primaryAxis,
    gap: '8px',
    minWidth: 0,
    minHeight: 0,
    ...style,
  };

  const primaryPaneStyle: CSSProperties = {
    flex: plan.primaryFlex,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  };

  const secondaryRailStyle: CSSProperties = {
    flex: plan.secondaryFlex || 0,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: plan.secondaryAxis,
    flexWrap: plan.secondaryAxis === 'row' ? secondaryWrap : 'nowrap',
    overflowX: secondaryOverflowX,
    gap: '8px',
    alignContent: 'stretch',
    justifyContent: 'stretch',
  };

  const primaryPane = (
    <div style={primaryPaneStyle}>
      {primaryLabel ? (
        <div style={{ flexShrink: 0 }}>
          {primaryLabel}
        </div>
      ) : null}
      <div style={{ minWidth: 0, minHeight: 0, flex: 1, display: 'flex' }}>
        {primaryItem.node}
      </div>
    </div>
  );

  const secondaryPane = secondaryItems.length > 0 ? (
    <div style={secondaryRailStyle}>
      {secondaryLabel ? (
        <div style={{ width: '100%', flexShrink: 0 }}>
          {secondaryLabel}
        </div>
      ) : null}
      {secondaryItems.map((item) => (
        <div
          key={item.id}
          data-testid={item.testId}
          aria-label={item.roleLabel}
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPrimaryItemChange?.(item.id);
            item.onPress?.();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onPrimaryItemChange?.(item.id);
            item.onPress?.();
          }}
          style={{
            minWidth: 0,
            minHeight: 0,
            flex: secondaryItemFlex ?? (plan.secondaryAxis === 'row' ? '1 1 0' : '0 0 auto'),
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: 0,
            border: 0,
            background: 'transparent',
            outline: 'none',
          }}
        >
          {item.node}
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div
      className={className}
      data-testid={testId}
      data-window-group-primary-axis={plan.primaryAxis}
      data-window-group-secondary-axis={plan.secondaryAxis}
      data-window-group-secondary-placement={secondaryPlacement}
      style={rootStyle}
    >
      {secondaryPlacement === 'before' ? secondaryPane : null}
      {primaryPane}
      {secondaryPlacement === 'after' ? secondaryPane : null}
    </div>
  );
}
