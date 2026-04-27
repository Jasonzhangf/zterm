// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../lib/types';
import { TerminalHeader } from './TerminalHeader';

if (!HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
}

function makeSession(): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'local',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'zterm',
    title: 'zterm',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace',
      revision: 1,
    },
  };
}

describe('TerminalHeader', () => {
  it('uses the UI-shell top inset as the single header padding truth', () => {
    const session = makeSession();
    const { container } = render(
      <TerminalHeader
        sessions={[session]}
        activeSession={session}
        topInsetPx={24}
        onBack={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenTabManager={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
      />,
    );

    const root = container.firstElementChild as HTMLElement | null;
    expect(root).toBeTruthy();
    expect(root?.style.padding).toBe('40px 6px 6px');
  });
});
