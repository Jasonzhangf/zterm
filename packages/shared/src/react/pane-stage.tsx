import type { CSSProperties, ReactNode } from 'react';

export interface PaneSlotDefinition {
  id: string;
  title: string;
  subtitle: string;
  badge?: string;
  widthWeight?: number;
  hideHeader?: boolean;
  render: () => ReactNode;
}

interface PaneStageProps {
  columns: number;
  slots: PaneSlotDefinition[];
  columnTemplate?: string;
}

interface PaneFrameProps {
  index: number;
  slot: PaneSlotDefinition;
  children: ReactNode;
  showDivider: boolean;
}

const frameStyle: CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'linear-gradient(180deg, rgba(15, 20, 31, 0.98) 0%, rgba(10, 14, 24, 0.98) 100%)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 10px',
  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  background: 'rgba(255, 255, 255, 0.018)',
};

const indexStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  minWidth: '24px',
  height: '20px',
  borderRadius: '999px',
  background: 'rgba(61, 126, 255, 0.18)',
  color: '#cfe0ff',
  fontWeight: 700,
  fontSize: '9px',
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

function PaneFrame({ index, slot, children, showDivider }: PaneFrameProps) {
  return (
    <section
      style={{
        ...frameStyle,
        borderLeft: showDivider ? '1px solid rgba(255, 255, 255, 0.08)' : undefined,
      }}
    >
      {slot.hideHeader ? null : (
        <div style={headerStyle}>
          <div style={{ minWidth: 0, display: 'flex', gap: '8px', alignItems: 'center', flex: 1 }}>
            <span style={indexStyle}>{String(index + 1).padStart(2, '0')}</span>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: '13px', lineHeight: 1.15 }}>{slot.title}</h2>
              <p style={{ margin: '1px 0 0', color: '#8393a8', lineHeight: 1.25, fontSize: '10px' }}>{slot.subtitle}</p>
            </div>
          </div>
          {slot.badge ? (
            <div
              style={{
                flexShrink: 0,
                borderRadius: '999px',
                padding: '3px 7px',
                background: 'rgba(59, 204, 160, 0.14)',
                color: '#7ff1cc',
                fontSize: '9px',
                fontWeight: 700,
              }}
            >
              {slot.badge}
            </div>
          ) : null}
        </div>
      )}

      <div style={{ ...bodyStyle, padding: slot.hideHeader ? '8px' : bodyStyle.padding }}>{children}</div>
    </section>
  );
}

export function PaneStage({ columns, slots, columnTemplate }: PaneStageProps) {
  const visibleSlots = slots.slice(0, columns);
  const template = columnTemplate || visibleSlots.map((slot) => `${slot.widthWeight || 1}fr`).join(' ');

  return (
    <main
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: template,
        gap: 0,
        overflow: 'hidden',
        borderRadius: '14px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        background: 'rgba(8, 10, 15, 0.9)',
      }}
    >
      {visibleSlots.map((slot, index) => (
        <PaneFrame
          key={slot.id}
          index={index}
          slot={slot}
          showDivider={index > 0}
        >
          {slot.render()}
        </PaneFrame>
      ))}
    </main>
  );
}
