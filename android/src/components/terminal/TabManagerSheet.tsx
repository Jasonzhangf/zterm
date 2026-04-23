import { useEffect, useMemo, useRef, useState } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import type { SavedTabList, Session } from '../../lib/types';

const DRAG_HANDLE_LONG_PRESS_MS = 360;

interface TabManagerSheetProps {
  open: boolean;
  sessions: Session[];
  activeSessionId?: string | null;
  savedTabLists: SavedTabList[];
  onClose: () => void;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onOpenQuickTabPicker: () => void;
  onSaveCurrentTabList: (name: string) => void;
  onLoadSavedTabList: (listId: string) => void;
  onDeleteSavedTabList: (listId: string) => void;
  onExportCurrentTabList: () => Promise<string> | string;
  onExportSavedTabList: (listId: string) => Promise<string> | string;
  onImportSavedTabLists: (raw: string) => { ok: boolean; message: string };
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function moveSessionItem(sessions: Session[], sessionId: string, toIndex: number) {
  const currentIndex = sessions.findIndex((session) => session.id === sessionId);
  if (currentIndex < 0) {
    return sessions;
  }

  const nextIndex = Math.max(0, Math.min(toIndex, sessions.length - 1));
  if (currentIndex === nextIndex) {
    return sessions;
  }

  const nextSessions = [...sessions];
  const [session] = nextSessions.splice(currentIndex, 1);
  nextSessions.splice(nextIndex, 0, session);
  return nextSessions;
}

export function TabManagerSheet({
  open,
  sessions,
  activeSessionId,
  savedTabLists,
  onClose,
  onSwitchSession,
  onRenameSession,
  onCloseSession,
  onMoveSession,
  onOpenQuickTabPicker,
  onSaveCurrentTabList,
  onLoadSavedTabList,
  onDeleteSavedTabList,
  onExportCurrentTabList,
  onExportSavedTabList,
  onImportSavedTabLists,
}: TabManagerSheetProps) {
  const [statusMessage, setStatusMessage] = useState('');
  const [importDraft, setImportDraft] = useState('');
  const [importVisible, setImportVisible] = useState(false);
  const dragTimerRef = useRef<number | null>(null);
  const rowListRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<{
    sessionId: string;
    pointerId: number;
    startY: number;
    startIndex: number;
    targetIndex: number;
    offsetY: number;
  } | null>(null);
  const dragStateRef = useRef<typeof dragState>(null);

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  const setDragStateSync = (
    next:
      | {
          sessionId: string;
          pointerId: number;
          startY: number;
          startIndex: number;
          targetIndex: number;
          offsetY: number;
        }
      | null,
  ) => {
    dragStateRef.current = next;
    setDragState(next);
  };

  const orderedSavedLists = useMemo(
    () => [...savedTabLists].sort((left, right) => right.updatedAt - left.updatedAt),
    [savedTabLists],
  );

  const previewSessions = useMemo(() => {
    if (!dragState) {
      return sessions;
    }
    return moveSessionItem(sessions, dragState.sessionId, dragState.targetIndex);
  }, [dragState, sessions]);

  const clearDragTimer = () => {
    if (dragTimerRef.current !== null) {
      window.clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }
  };

  const requestRename = (session: Session) => {
    const next = window.prompt('Rename tab', session.customName || session.sessionName)?.trim();
    if (!next) {
      return;
    }
    onRenameSession(session.id, next);
  };

  const getTargetIndex = (clientY: number, draggedSessionId: string) => {
    const nodes = Array.from(rowListRef.current?.querySelectorAll<HTMLElement>('[data-tab-list-row="true"]') || []);
    if (nodes.length === 0) {
      return -1;
    }

    const candidateNodes = nodes.filter((node) => node.dataset.tabRowSessionId !== draggedSessionId);
    if (candidateNodes.length === 0) {
      return 0;
    }

    let insertionIndex = 0;
    candidateNodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      if (clientY >= centerY) {
        insertionIndex += 1;
      }
    });
    return insertionIndex;
  };

  const handleExport = async (resolveText: () => Promise<string> | string) => {
    const raw = await resolveText();
    const copied = await copyText(raw);
    if (copied) {
      setStatusMessage('已复制到剪贴板。');
      return;
    }
    setImportDraft(raw);
    setImportVisible(true);
    setStatusMessage('当前环境不支持剪贴板，已把 JSON 放到输入框。');
  };

  if (!open) {
    return null;
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120,
        backgroundColor: 'rgba(10, 14, 24, 0.48)',
        display: 'flex',
        alignItems: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxHeight: '88dvh',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          borderTopLeftRadius: '28px',
          borderTopRightRadius: '28px',
          backgroundColor: mobileTheme.colors.lightBg,
          padding: `${mobileTheme.safeArea.top} 16px ${mobileTheme.safeArea.bottom}`,
          boxShadow: mobileTheme.shadow.strong,
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '21px', fontWeight: 800, color: mobileTheme.colors.lightText }}>Tab Menu</div>
            <div style={{ marginTop: '4px', fontSize: '13px', lineHeight: 1.5, color: mobileTheme.colors.lightMuted }}>
              长按右侧排序按钮可重排当前 tab。下面可以保存/导出/导入/加载 tab 列表。
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '14px',
              border: 'none',
              backgroundColor: '#ffffff',
              color: mobileTheme.colors.lightText,
              fontSize: '20px',
              boxShadow: mobileTheme.shadow.soft,
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            borderRadius: '22px',
            padding: '14px',
            backgroundColor: '#ffffff',
            boxShadow: mobileTheme.shadow.soft,
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '10px',
          }}
        >
          <button
            onClick={onOpenQuickTabPicker}
            style={{
              minHeight: '46px',
              border: 'none',
              borderRadius: '16px',
              backgroundColor: mobileTheme.colors.shell,
              color: '#ffffff',
              fontWeight: 800,
            }}
          >
            + New Tab
          </button>
          <button
            onClick={() => {
              const nextName = window.prompt('保存当前 tab 列表为', `tabs-${new Date().toLocaleDateString('zh-CN')}`)?.trim();
              if (!nextName) {
                return;
              }
              onSaveCurrentTabList(nextName);
              setStatusMessage(`已保存 tab 列表：${nextName}`);
            }}
            style={{
              minHeight: '46px',
              border: 'none',
              borderRadius: '16px',
              backgroundColor: mobileTheme.colors.accentSoft,
              color: mobileTheme.colors.lightText,
              fontWeight: 800,
            }}
          >
            Save Current
          </button>
          <button
            onClick={() => void handleExport(onExportCurrentTabList)}
            style={{
              minHeight: '44px',
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              borderRadius: '16px',
              backgroundColor: '#ffffff',
              color: mobileTheme.colors.lightText,
              fontWeight: 700,
            }}
          >
            Export Current
          </button>
          <button
            onClick={() => {
              setImportVisible((value) => !value);
              setStatusMessage('');
            }}
            style={{
              minHeight: '44px',
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              borderRadius: '16px',
              backgroundColor: '#ffffff',
              color: mobileTheme.colors.lightText,
              fontWeight: 700,
            }}
          >
            Import Lists
          </button>
        </div>

        {statusMessage && (
          <div
            style={{
              borderRadius: '16px',
              padding: '10px 12px',
              backgroundColor: '#f6f8fb',
              color: mobileTheme.colors.lightText,
              fontSize: '12px',
            }}
          >
            {statusMessage}
          </div>
        )}

        {importVisible && (
          <div
            style={{
              borderRadius: '22px',
              padding: '14px',
              backgroundColor: '#ffffff',
              boxShadow: mobileTheme.shadow.soft,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.lightText }}>Import / Export JSON</div>
            <textarea
              value={importDraft}
              onChange={(event) => setImportDraft(event.target.value)}
              placeholder="粘贴导出的 tab list JSON"
              style={{
                minHeight: '180px',
                borderRadius: '16px',
                border: `1px solid ${mobileTheme.colors.lightBorder}`,
                padding: '12px',
                resize: 'vertical',
                fontSize: '13px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => {
                  const result = onImportSavedTabLists(importDraft);
                  setStatusMessage(result.message);
                  if (result.ok) {
                    setImportDraft('');
                    setImportVisible(false);
                  }
                }}
                style={{
                  flex: 1,
                  minHeight: '44px',
                  border: 'none',
                  borderRadius: '16px',
                  backgroundColor: mobileTheme.colors.shell,
                  color: '#ffffff',
                  fontWeight: 800,
                }}
              >
                Import
              </button>
              <button
                onClick={() => {
                  setImportDraft('');
                  setImportVisible(false);
                }}
                style={{
                  flex: 1,
                  minHeight: '44px',
                  border: `1px solid ${mobileTheme.colors.lightBorder}`,
                  borderRadius: '16px',
                  backgroundColor: '#ffffff',
                  color: mobileTheme.colors.lightText,
                  fontWeight: 700,
                }}
              >
                Close
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            borderRadius: '22px',
            padding: '14px',
            backgroundColor: '#ffffff',
            boxShadow: mobileTheme.shadow.soft,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.lightText }}>Current Tabs</div>
          <div ref={rowListRef} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {previewSessions.map((session, index) => {
              const active = session.id === activeSessionId;
              const dragging = dragState?.sessionId === session.id;
              return (
                <div
                  key={session.id}
                  data-tab-list-row="true"
                  data-tab-row-session-id={session.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    borderRadius: '18px',
                    padding: '10px 12px',
                    backgroundColor: active ? 'rgba(31,214,122,0.14)' : '#f6f8fb',
                    transform: dragging ? `translateY(${dragState?.offsetY || 0}px)` : 'translateY(0)',
                    boxShadow: dragging ? '0 10px 18px rgba(0,0,0,0.16)' : 'none',
                    zIndex: dragging ? 3 : 1,
                    position: 'relative',
                  }}
                >
                  <button
                    onClick={() => onSwitchSession(session.id)}
                    style={{
                      flex: 1,
                      border: 'none',
                      background: 'transparent',
                      textAlign: 'left',
                      padding: 0,
                      color: mobileTheme.colors.lightText,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ fontWeight: 800 }}>{session.customName || session.sessionName}</div>
                      {active && (
                        <span style={{ fontSize: '10px', color: mobileTheme.colors.accent, fontWeight: 800 }}>ACTIVE</span>
                      )}
                    </div>
                    <div style={{ marginTop: '4px', fontSize: '11px', color: mobileTheme.colors.lightMuted }}>
                      {session.bridgeHost}:{session.bridgePort} · {session.sessionName}
                    </div>
                  </button>
                  <button
                    onClick={() => requestRename(session)}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      border: 'none',
                      backgroundColor: '#ffffff',
                      color: mobileTheme.colors.lightText,
                    }}
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => onCloseSession(session.id)}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      border: 'none',
                      backgroundColor: 'rgba(255,124,146,0.16)',
                      color: mobileTheme.colors.danger,
                    }}
                  >
                    ×
                  </button>
                  <button
                    title="Long press to sort"
                    onPointerDown={(event) => {
                      clearDragTimer();
                      event.preventDefault();
                      dragTimerRef.current = window.setTimeout(() => {
                        setDragStateSync({
                          sessionId: session.id,
                          pointerId: event.pointerId,
                          startY: event.clientY,
                          startIndex: index,
                          targetIndex: index,
                          offsetY: 0,
                        });
                      }, DRAG_HANDLE_LONG_PRESS_MS);
                      try {
                        event.currentTarget.setPointerCapture(event.pointerId);
                      } catch {}
                    }}
                    onPointerMove={(event) => {
                      const currentDragState = dragStateRef.current;
                      if (!currentDragState || currentDragState.sessionId !== session.id || currentDragState.pointerId !== event.pointerId) {
                        return;
                      }
                      event.preventDefault();
                      const targetIndex = getTargetIndex(event.clientY, session.id);
                      setDragStateSync({
                        ...currentDragState,
                        offsetY: event.clientY - currentDragState.startY,
                        targetIndex: targetIndex >= 0 ? targetIndex : currentDragState.targetIndex,
                      });
                    }}
                    onPointerUp={(event) => {
                      clearDragTimer();
                      const currentDragState = dragStateRef.current;
                      if (currentDragState && currentDragState.sessionId === session.id && currentDragState.pointerId === event.pointerId) {
                        if (currentDragState.targetIndex !== currentDragState.startIndex) {
                          onMoveSession(session.id, currentDragState.targetIndex);
                        }
                        setDragStateSync(null);
                      }
                      try {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      } catch {}
                    }}
                    onPointerCancel={(event) => {
                      clearDragTimer();
                      const currentDragState = dragStateRef.current;
                      if (currentDragState?.sessionId === session.id && currentDragState.pointerId === event.pointerId) {
                        setDragStateSync(null);
                      }
                      try {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      } catch {}
                    }}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      border: 'none',
                      backgroundColor: mobileTheme.colors.shellMuted,
                      color: '#ffffff',
                      fontWeight: 800,
                      touchAction: 'none',
                    }}
                    aria-label={`Sort ${session.customName || session.sessionName}`}
                  >
                    ≡
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            borderRadius: '22px',
            padding: '14px',
            backgroundColor: '#ffffff',
            boxShadow: mobileTheme.shadow.soft,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.lightText }}>Saved Tab Lists</div>
          {orderedSavedLists.length === 0 ? (
            <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>还没有保存过 tab 列表。</div>
          ) : (
            orderedSavedLists.map((list) => (
              <div
                key={list.id}
                style={{
                  borderRadius: '18px',
                  padding: '12px',
                  backgroundColor: '#f6f8fb',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div>
                  <div style={{ fontWeight: 800, color: mobileTheme.colors.lightText }}>{list.name}</div>
                  <div style={{ marginTop: '4px', fontSize: '11px', color: mobileTheme.colors.lightMuted }}>
                    {list.tabs.length} tabs · updated {formatTime(list.updatedAt)}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}>
                  <button
                    onClick={() => {
                      onLoadSavedTabList(list.id);
                      setStatusMessage(`已加载列表：${list.name}`);
                    }}
                    style={{
                      minHeight: '40px',
                      border: 'none',
                      borderRadius: '14px',
                      backgroundColor: mobileTheme.colors.shell,
                      color: '#ffffff',
                      fontWeight: 800,
                    }}
                  >
                    Load
                  </button>
                  <button
                    onClick={() => void handleExport(() => onExportSavedTabList(list.id))}
                    style={{
                      minHeight: '40px',
                      border: 'none',
                      borderRadius: '14px',
                      backgroundColor: '#ffffff',
                      color: mobileTheme.colors.lightText,
                      fontWeight: 700,
                    }}
                  >
                    Export
                  </button>
                  <button
                    onClick={() => {
                      if (!window.confirm(`删除列表 ${list.name} ?`)) {
                        return;
                      }
                      onDeleteSavedTabList(list.id);
                      setStatusMessage(`已删除列表：${list.name}`);
                    }}
                    style={{
                      minHeight: '40px',
                      border: 'none',
                      borderRadius: '14px',
                      backgroundColor: 'rgba(255,124,146,0.16)',
                      color: mobileTheme.colors.danger,
                      fontWeight: 700,
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
