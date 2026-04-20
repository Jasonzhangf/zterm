import type { CSSProperties, ReactNode } from 'react';

export interface PaneSlotDefinition {
  id: string;
  title: string;
  subtitle: string;
  badge?: string;
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
  background: 'linear-gradient(180deg, rgba(18, 24, 38, 0.96) 0%, rgba(13, 18, 29, 0.96) 100%)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  gap: '14px',
  alignItems: 'flex-start',
  padding: '20px 20px 16px',
  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
};

const indexStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  minWidth: '40px',
  height: '40px',
  borderRadius: '12px',
  background: 'rgba(61, 126, 255, 0.14)',
  color: '#9fcbff',
  fontWeight: 700,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: '18px',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
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
        <span style={indexStyle}>{String(index + 1).padStart(2, '0')}</span>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>{slot.title}</h2>
          <p style={{ margin: '6px 0 0', color: '#97a4b5', lineHeight: 1.45 }}>{slot.subtitle}</p>
        </div>
      </div>

      <div style={bodyStyle}>
        {slot.badge ? (
          <div
            style={{
              alignSelf: 'flex-start',
              borderRadius: '999px',
              padding: '6px 12px',
              background: 'rgba(59, 204, 160, 0.16)',
              color: '#7ff1cc',
              fontSize: '12px',
              fontWeight: 700,
            }}
          >
            {slot.badge}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export function PaneStage({ columns, slots }: PaneStageProps) {
  const visibleSlots = slots.slice(0, columns);

  return (
    <main
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${visibleSlots.length}, minmax(0, 1fr))`,
        gap: 0,
        overflow: 'hidden',
        borderRadius: '24px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        background: 'rgba(8, 10, 15, 0.78)',
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
