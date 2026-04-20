import type { CSSProperties, ReactNode } from 'react';

export interface PaneSlotDefinition {
  id: string;
  title: string;
  subtitle: string;
  badge?: string;
  widthWeight?: number;
  render: () => ReactNode;
}

interface PaneStageProps {
  columns: number;
  slots: PaneSlotDefinition[];
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
  gap: '8px',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 12px',
  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  background: 'rgba(255, 255, 255, 0.018)',
};

const indexStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  minWidth: '28px',
  height: '24px',
  borderRadius: '999px',
  background: 'rgba(61, 126, 255, 0.18)',
  color: '#cfe0ff',
  fontWeight: 700,
  fontSize: '10px',
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

function PaneFrame({ index, slot, children, showDivider }: PaneFrameProps) {
  return (
    <section
      style={{
        ...frameStyle,
        borderLeft: showDivider ? '1px solid rgba(255, 255, 255, 0.08)' : undefined,
      }}
    >
      <div style={headerStyle}>
        <div style={{ minWidth: 0, display: 'flex', gap: '8px', alignItems: 'center', flex: 1 }}>
          <span style={indexStyle}>{String(index + 1).padStart(2, '0')}</span>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: '14px', lineHeight: 1.2 }}>{slot.title}</h2>
            <p style={{ margin: '2px 0 0', color: '#8393a8', lineHeight: 1.3, fontSize: '11px' }}>{slot.subtitle}</p>
          </div>
        </div>
        {slot.badge ? (
          <div
            style={{
              flexShrink: 0,
              borderRadius: '999px',
              padding: '4px 8px',
              background: 'rgba(59, 204, 160, 0.14)',
              color: '#7ff1cc',
              fontSize: '10px',
              fontWeight: 700,
            }}
          >
            {slot.badge}
          </div>
        ) : null}
      </div>

      <div style={bodyStyle}>{children}</div>
    </section>
  );
}

export function PaneStage({ columns, slots }: PaneStageProps) {
  const visibleSlots = slots.slice(0, columns);
  const template = visibleSlots.map((slot) => `${slot.widthWeight || 1}fr`).join(' ');

  return (
    <main
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: template,
        gap: 0,
        overflow: 'hidden',
        borderRadius: '18px',
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
