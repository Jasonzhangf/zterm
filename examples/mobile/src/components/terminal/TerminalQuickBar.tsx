import { useEffect, useMemo, useRef, useState } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import type { QuickAction } from '../../lib/types';

const FLOATING_BUBBLE_SIZE = 54;
const FLOATING_BUBBLE_MARGIN = 14;
const FLOATING_BUBBLE_RESERVED_WIDTH = FLOATING_BUBBLE_SIZE + FLOATING_BUBBLE_MARGIN + 10;
const FLOATING_BUBBLE_LONG_PRESS_MS = 260;
const QUICK_BAR_SIDE_PADDING = 8;
const QUICK_BAR_ROW_GAP = 6;

const BASE_ACTIONS = [
  { id: 'image', label: '图', sequence: '' },
  { id: 'continue', label: '继续', sequence: '继续执行\r' },
  { id: 'esc', label: 'Esc', sequence: '\x1b' },
  { id: 'tab', label: 'Tab', sequence: '\t' },
  { id: 'enter', label: 'Enter', sequence: '\r' },
  { id: 'left', label: '←', sequence: '\x1b[D' },
  { id: 'up', label: '↑', sequence: '\x1b[A' },
  { id: 'down', label: '↓', sequence: '\x1b[B' },
  { id: 'right', label: '→', sequence: '\x1b[C' },
  { id: 'space', label: 'Space', sequence: ' ' },
  { id: 'backspace', label: 'Bksp', sequence: '\x7f' },
  { id: 'shift-tab', label: 'S-Tab', sequence: '\x1b[Z' },
  { id: 'shift-enter', label: 'S-Enter', sequence: '\n' },
  { id: 'paste', label: 'Paste', sequence: '\x16' },
  { id: 'keyboard', label: 'IME', sequence: '' },
];

interface TerminalQuickBarProps {
  quickActions: QuickAction[];
  onSendSequence?: (sequence: string) => void;
  onImagePaste?: (file: File) => Promise<void> | void;
  keyboardVisible?: boolean;
  keyboardInsetPx?: number;
  onToggleKeyboard?: () => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
}

interface DraftQuickAction extends QuickAction {
  textInput: string;
}

function editorInputStyle() {
  return {
    width: '100%',
    minHeight: '44px',
    padding: '10px 12px',
    borderRadius: '14px',
    border: '1px solid rgba(255,255,255,0.12)',
    backgroundColor: '#1f2437',
    color: '#fff',
    fontSize: '14px',
  } as const;
}

function createDraftActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `quick-action-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function toDraftActions(actions: QuickAction[]): DraftQuickAction[] {
  return actions.map((action) => ({
    ...action,
    textInput: action.sequence,
  }));
}

function normalizeDraftActions(actions: DraftQuickAction[]): QuickAction[] {
  return actions.map(({ textInput, ...action }, index) => ({
    ...action,
    order: index,
    sequence: textInput,
  }));
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex || toIndex < 0 || toIndex >= items.length) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function blurCurrentTarget(target: EventTarget | null) {
  if (target instanceof HTMLButtonElement) {
    target.blur();
  }
}

export function TerminalQuickBar({
  quickActions,
  keyboardVisible = false,
  keyboardInsetPx = 0,
  onImagePaste,
  onToggleKeyboard,
  onQuickActionsChange,
  onSendSequence,
}: TerminalQuickBarProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [floatingMenuOpen, setFloatingMenuOpen] = useState(false);
  const [draftActions, setDraftActions] = useState<DraftQuickAction[]>(() => toDraftActions(quickActions));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftTextInput, setDraftTextInput] = useState('');
  const [floatingBubbleOffset, setFloatingBubbleOffset] = useState({ x: 0, y: 0 });
  const suppressKeyboardClickRef = useRef(false);
  const suppressBubbleClickRef = useRef(false);
  const floatingBubblePressTimerRef = useRef<number | null>(null);
  const floatingBubbleDragRef = useRef({
    pointerId: -1,
    active: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  });
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRowRef = useRef<HTMLDivElement | null>(null);
  const scrollTrackRef = useRef<HTMLDivElement | null>(null);
  const suppressScrollRowClickRef = useRef(false);
  const [scrollTrackOffset, setScrollTrackOffset] = useState(0);
  const [maxScrollTrackOffset, setMaxScrollTrackOffset] = useState(0);
  const scrollRowDragRef = useRef({
    pointerId: -1,
    active: false,
    moved: false,
    startX: 0,
    startOffset: 0,
  });
  const scrollRowTouchRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startOffset: 0,
  });

  const sortedQuickActions = useMemo(() => quickActions.slice().sort((a, b) => a.order - b.order), [quickActions]);
  const editingIndex = editingId ? draftActions.findIndex((action) => action.id === editingId) : -1;

  const persistDraftActions = (nextActions: DraftQuickAction[]) => {
    const normalized = normalizeDraftActions(nextActions);
    onQuickActionsChange?.(normalized);
    setDraftActions(toDraftActions(normalized));
  };

  const openEditor = (mode: 'list' | 'create' | 'edit' = 'list', action?: DraftQuickAction) => {
    setDraftActions(toDraftActions(sortedQuickActions));
    setFloatingMenuOpen(false);
    if (mode === 'edit' && action) {
      setEditingId(action.id);
      setDraftLabel(action.label);
      setDraftTextInput(action.textInput);
    } else if (mode === 'create') {
      setEditingId('new');
      setDraftLabel('');
      setDraftTextInput('');
    } else {
      setEditingId(null);
      setDraftLabel('');
      setDraftTextInput('');
    }
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingId(null);
    setDraftLabel('');
    setDraftTextInput('');
  };

  const openDraftForm = (action?: DraftQuickAction) => {
    if (action) {
      setEditingId(action.id);
      setDraftLabel(action.label);
      setDraftTextInput(action.textInput);
      return;
    }

    setEditingId('new');
    setDraftLabel('');
    setDraftTextInput('');
  };

  const saveDraftForm = () => {
    const nextLabel = draftLabel.trim() || '新片段';
    const nextTextInput = draftTextInput;

    const nextActions = editingId && editingId !== 'new'
      ? draftActions.map((action) =>
          action.id === editingId
            ? { ...action, label: nextLabel, textInput: nextTextInput }
            : action,
        )
      : [
        ...draftActions,
        {
          id: createDraftActionId(),
          label: nextLabel,
          textInput: nextTextInput,
          sequence: nextTextInput,
          order: draftActions.length,
        },
      ];
    persistDraftActions(nextActions);

    setEditingId(null);
    setDraftLabel('');
    setDraftTextInput('');
  };

  const pinnedActions = useMemo(
    () => BASE_ACTIONS.filter((action) => ['image', 'continue', 'esc', 'tab', 'backspace', 'keyboard'].includes(action.id)),
    [],
  );

  const scrollActions = useMemo(
    () => BASE_ACTIONS.filter((action) => !['image', 'continue', 'keyboard', 'esc', 'tab', 'backspace'].includes(action.id)),
    [],
  );

  const clearFloatingBubblePressTimer = () => {
    if (floatingBubblePressTimerRef.current) {
      window.clearTimeout(floatingBubblePressTimerRef.current);
      floatingBubblePressTimerRef.current = null;
    }
  };

  useEffect(() => {
    const host = scrollRowRef.current;
    const track = scrollTrackRef.current;
    if (!host || !track) {
      return;
    }

    const syncTrackMetrics = () => {
      const nextMax = Math.max(0, track.scrollWidth - host.clientWidth);
      setMaxScrollTrackOffset(nextMax);
      setScrollTrackOffset((current) => Math.min(current, nextMax));
    };

    syncTrackMetrics();
    const observer = new ResizeObserver(syncTrackMetrics);
    observer.observe(host);
    observer.observe(track);
    window.addEventListener('resize', syncTrackMetrics);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncTrackMetrics);
    };
  }, [scrollActions.length]);

  return (
    <div
      style={{
        padding: `8px 0 ${mobileTheme.safeArea.bottom}`,
        position: 'relative',
        backgroundColor: 'rgba(11, 15, 24, 0.88)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          if (!file) {
            return;
          }
          try {
            await onImagePaste?.(file);
          } catch (error) {
            alert(error instanceof Error ? error.message : 'Failed to paste image');
          }
        }}
      />
      {editorOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 120,
            backgroundColor: 'rgba(8, 10, 18, 0.78)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'flex-end',
            paddingBottom: `${Math.max(0, keyboardInsetPx)}px`,
          }}
        >
          <div
            style={{
              width: '100%',
              maxHeight: `calc(100dvh - ${Math.max(16, keyboardInsetPx + 16)}px)`,
              borderRadius: '26px 26px 0 0',
              backgroundColor: '#f7f8fb',
              color: mobileTheme.colors.lightText,
              boxShadow: '0 -20px 50px rgba(0,0,0,0.28)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 18px 12px',
                borderBottom: '1px solid rgba(23, 27, 45, 0.08)',
                backgroundColor: '#fff',
              }}
            >
              <div
                style={{
                  width: '42px',
                  height: '5px',
                  borderRadius: '999px',
                  backgroundColor: 'rgba(23, 27, 45, 0.15)',
                  margin: '0 auto 12px',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                  onClick={closeEditor}
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '999px',
                    border: 'none',
                    backgroundColor: '#eef2f8',
                    color: mobileTheme.colors.lightText,
                    fontSize: '20px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  aria-label="Close shortcut editor"
                >
                  ×
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '20px', fontWeight: 800 }}>快捷输入设置</div>
                </div>
              </div>
            </div>

            <div
              style={{
                padding: '16px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>当前快捷输入</div>
                </div>
                <button
                  onClick={() => openDraftForm()}
                  style={{
                    minHeight: '38px',
                    padding: '0 14px',
                    borderRadius: '999px',
                    border: 'none',
                    backgroundColor: 'rgba(22, 119, 255, 0.12)',
                    color: '#1677ff',
                    fontWeight: 800,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  + 添加
                </button>
              </div>

              <div
                style={{
                  borderRadius: '20px',
                  backgroundColor: '#fff',
                  border: '1px solid rgba(23, 27, 45, 0.08)',
                  overflow: 'hidden',
                }}
              >
                {draftActions.length === 0 ? (
                  <div style={{ height: '12px' }} />
                ) : (
                  draftActions.map((action, index) => (
                    <div
                      key={action.id}
                      style={{
                        padding: '14px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        borderTop: index === 0 ? 'none' : '1px solid rgba(23, 27, 45, 0.08)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '17px', fontWeight: 600 }}>{action.label}</div>
                        <div
                          style={{
                            fontSize: '12px',
                            color: mobileTheme.colors.lightMuted,
                            marginTop: '4px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {formatSnippetPreview(action.textInput) || '(空文本)'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <button
                          onClick={() => persistDraftActions(moveItem(draftActions, index, index - 1))}
                          disabled={index === 0}
                          style={overlayIconButton(index === 0)}
                          aria-label={`Move ${action.label} up`}
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => persistDraftActions(moveItem(draftActions, index, index + 1))}
                          disabled={index === draftActions.length - 1}
                          style={overlayIconButton(index === draftActions.length - 1)}
                          aria-label={`Move ${action.label} down`}
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => openDraftForm(action)}
                          style={overlayTextButton('#eef2f8', mobileTheme.colors.lightText)}
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => {
                            persistDraftActions(draftActions.filter((item) => item.id !== action.id));
                            if (editingId === action.id) {
                              setEditingId(null);
                              setDraftLabel('');
                              setDraftTextInput('');
                            }
                          }}
                          style={overlayTextButton('rgba(255, 124, 146, 0.12)', mobileTheme.colors.danger)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {(editingId !== null || draftActions.length === 0) && (
                <div
                  style={{
                    borderRadius: '20px',
                    backgroundColor: '#fff',
                    border: '1px solid rgba(23, 27, 45, 0.08)',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 700 }}>
                      {editingIndex >= 0 ? '编辑快捷输入' : '新增快捷输入'}
                    </div>
                  </div>

                  <input
                    value={draftLabel}
                    onChange={(event) => setDraftLabel(event.target.value)}
                    placeholder="显示名称"
                    style={lightEditorInputStyle()}
                  />
                  <textarea
                    value={draftTextInput}
                    onChange={(event) => setDraftTextInput(event.target.value)}
                    placeholder="保存好的字符串，例如：git status"
                    style={{
                      ...lightEditorInputStyle(),
                      minHeight: '96px',
                      resize: 'vertical',
                      whiteSpace: 'pre-wrap',
                    }}
                  />

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setDraftLabel('');
                        setDraftTextInput('');
                      }}
                      style={{
                        flex: 1,
                        minHeight: '44px',
                        border: 'none',
                        borderRadius: '14px',
                        backgroundColor: '#eef2f8',
                        color: mobileTheme.colors.lightText,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      取消
                    </button>
                    <button
                      onClick={saveDraftForm}
                      style={{
                        flex: 1,
                        minHeight: '44px',
                        border: 'none',
                        borderRadius: '14px',
                        backgroundColor: '#1677ff',
                        color: '#fff',
                        fontWeight: 800,
                        cursor: 'pointer',
                      }}
                    >
                      {editingIndex >= 0 ? '应用修改' : '添加快捷输入'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {floatingMenuOpen && !editorOpen && (
        <>
          <div
            onClick={() => setFloatingMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 129,
              backgroundColor: 'rgba(5, 8, 14, 0.18)',
            }}
          />
          <div
            style={{
              position: 'fixed',
              right: '12px',
              bottom: 'calc(124px + env(safe-area-inset-bottom, 0px))',
              zIndex: 130,
              width: 'min(320px, calc(100vw - 24px))',
              maxHeight: 'min(560px, calc(100dvh - 180px))',
              borderRadius: '22px',
              backgroundColor: 'rgba(23, 27, 45, 0.96)',
              color: '#fff',
              boxShadow: '0 20px 50px rgba(0,0,0,0.32)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div
              style={{
                padding: '14px 14px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
              }}
              >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '16px', fontWeight: 800 }}>快捷输入</div>
              </div>
              <button
                onClick={() => openEditor('create')}
                style={floatingPillButton('rgba(31,214,122,0.18)', mobileTheme.colors.accent)}
              >
                + 添加
              </button>
              <button
                onClick={() => openEditor('list')}
                style={floatingPillButton('rgba(255,255,255,0.1)', '#fff')}
              >
                管理
              </button>
            </div>

            <div
              style={{
                padding: '10px',
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                maxHeight: `${10 * 50}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              {sortedQuickActions.length === 0 ? (
                <div style={{ height: '8px' }} />
              ) : (
                sortedQuickActions.map((action) => {
                  const draftAction = {
                    ...action,
                    textInput: action.sequence,
                  };
                  return (
                    <div
                      key={action.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      <button
                        onClick={() => {
                          onSendSequence?.(action.sequence);
                          setFloatingMenuOpen(false);
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          minHeight: '42px',
                          border: 'none',
                          borderRadius: '14px',
                          backgroundColor: 'rgba(255,255,255,0.08)',
                          color: '#fff',
                          padding: '0 14px',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '10px',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{action.label}</span>
                        <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', flexShrink: 0 }}>
                          {formatSnippetPreview(action.sequence) || '(空)'}
                        </span>
                      </button>
                      <button
                        onClick={() => openEditor('edit', draftAction)}
                        style={{
                          width: '40px',
                          height: '40px',
                          borderRadius: '12px',
                          border: 'none',
                          backgroundColor: 'rgba(255,255,255,0.1)',
                          color: '#fff',
                          fontSize: '16px',
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                        aria-label={`Edit ${action.label}`}
                      >
                        ✎
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gap: `${QUICK_BAR_ROW_GAP}px`,
          padding: `0 ${FLOATING_BUBBLE_RESERVED_WIDTH}px 0 ${QUICK_BAR_SIDE_PADDING}px`,
          marginBottom: `${QUICK_BAR_ROW_GAP}px`,
        }}
      >
        {!editorOpen && (
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              blurCurrentTarget(event.currentTarget);
              event.currentTarget.setPointerCapture(event.pointerId);
              floatingBubbleDragRef.current = {
                pointerId: event.pointerId,
                active: false,
                startX: event.clientX,
                startY: event.clientY,
                originX: floatingBubbleOffset.x,
                originY: floatingBubbleOffset.y,
              };
              clearFloatingBubblePressTimer();
              floatingBubblePressTimerRef.current = window.setTimeout(() => {
                floatingBubbleDragRef.current.active = true;
                suppressBubbleClickRef.current = true;
              }, FLOATING_BUBBLE_LONG_PRESS_MS);
            }}
            onPointerMove={(event) => {
              const drag = floatingBubbleDragRef.current;
              if (drag.pointerId !== event.pointerId || !drag.active) {
                return;
              }
              event.preventDefault();
              setFloatingBubbleOffset({
                x: drag.originX + (event.clientX - drag.startX),
                y: drag.originY + (event.clientY - drag.startY),
              });
            }}
            onPointerUp={(event) => {
              clearFloatingBubblePressTimer();
              if (floatingBubbleDragRef.current.pointerId === event.pointerId) {
                if (floatingBubbleDragRef.current.active) {
                  suppressBubbleClickRef.current = true;
                  window.setTimeout(() => {
                    suppressBubbleClickRef.current = false;
                  }, 180);
                }
                floatingBubbleDragRef.current.active = false;
                floatingBubbleDragRef.current.pointerId = -1;
              }
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
              clearFloatingBubblePressTimer();
              floatingBubbleDragRef.current.active = false;
              floatingBubbleDragRef.current.pointerId = -1;
              try {
                event.currentTarget.releasePointerCapture(event.pointerId);
              } catch {}
            }}
            onClick={() => {
              if (suppressBubbleClickRef.current) {
                return;
              }
              setFloatingMenuOpen((current) => !current);
            }}
            style={{
              position: 'fixed',
              right: `${FLOATING_BUBBLE_MARGIN}px`,
              bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
              zIndex: 128,
              width: `${FLOATING_BUBBLE_SIZE}px`,
              height: `${FLOATING_BUBBLE_SIZE}px`,
              borderRadius: '999px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: floatingMenuOpen ? 'rgba(31,214,122,0.18)' : 'rgba(18, 24, 38, 0.72)',
              color: floatingMenuOpen ? mobileTheme.colors.accent : '#fff',
              fontSize: '24px',
              fontWeight: 800,
              boxShadow: '0 8px 18px rgba(0,0,0,0.24)',
              transform: `translate(${floatingBubbleOffset.x}px, ${floatingBubbleOffset.y}px)`,
              touchAction: 'none',
            }}
            aria-label="Toggle floating quick menu"
          >
            ⌘
          </button>
        )}
        {pinnedActions.map((action) => (
          <button
            key={action.id}
            tabIndex={-1}
            onPointerDown={(event) => {
              blurCurrentTarget(event.currentTarget);
              if (action.id !== 'keyboard') {
                return;
              }
              event.preventDefault();
              suppressKeyboardClickRef.current = true;
              onToggleKeyboard?.();
              window.setTimeout(() => {
                suppressKeyboardClickRef.current = false;
              }, 220);
            }}
            onClick={(event) => {
              blurCurrentTarget(event.currentTarget);
              if (action.id === 'keyboard') {
                if (suppressKeyboardClickRef.current) {
                  return;
                }
                onToggleKeyboard?.();
                return;
              }
              if (action.id === 'image') {
                imageInputRef.current?.click();
                return;
              }
              if (action.id === 'continue') {
                onSendSequence?.(action.sequence);
                return;
              }
              onSendSequence?.(action.sequence);
            }}
            style={{
              minHeight: '44px',
              width: '100%',
              minWidth: 0,
              padding: '0 4px',
              border: 'none',
              borderRadius: '14px',
              backgroundColor:
                action.id === 'keyboard' && keyboardVisible ? 'rgba(31,214,122,0.18)' : 'rgba(31, 38, 53, 0.68)',
              color: action.id === 'keyboard' && keyboardVisible ? mobileTheme.colors.accent : '#fff',
              fontSize: action.id === 'continue' ? '12px' : action.label.length > 2 ? '13px' : '18px',
              fontWeight: 700,
              cursor: 'pointer',
              flexShrink: 0 as const,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div
        ref={scrollRowRef}
        style={{
          minHeight: '60px',
          overflowX: 'auto',
          overflowY: 'hidden',
          WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-x',
          overscrollBehaviorX: 'contain',
          overscrollBehaviorY: 'none',
          padding: `8px ${FLOATING_BUBBLE_RESERVED_WIDTH}px 8px ${QUICK_BAR_SIDE_PADDING}px`,
          backgroundColor: 'rgba(255,255,255,0.02)',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
        onTouchStartCapture={(event) => {
          const host = scrollRowRef.current;
          const touch = event.touches[0];
          if (!host || !touch) {
            return;
          }
          scrollRowTouchRef.current = {
            active: true,
            moved: false,
            startX: touch.clientX,
            startOffset: scrollTrackOffset,
          };
        }}
        onTouchMoveCapture={(event) => {
          const drag = scrollRowTouchRef.current;
          const touch = event.touches[0];
          if (!drag.active || !touch) {
            return;
          }
          const deltaX = touch.clientX - drag.startX;
          if (Math.abs(deltaX) > 4) {
            drag.moved = true;
            suppressScrollRowClickRef.current = true;
            event.preventDefault();
          }
          const nextOffset = Math.max(0, Math.min(maxScrollTrackOffset, drag.startOffset - deltaX));
          setScrollTrackOffset(nextOffset);
        }}
        onTouchEndCapture={() => {
          scrollRowTouchRef.current.active = false;
          if (suppressScrollRowClickRef.current) {
            window.setTimeout(() => {
              suppressScrollRowClickRef.current = false;
            }, 120);
          }
        }}
        onTouchCancelCapture={() => {
          scrollRowTouchRef.current.active = false;
          if (suppressScrollRowClickRef.current) {
            window.setTimeout(() => {
              suppressScrollRowClickRef.current = false;
            }, 120);
          }
        }}
        onPointerDown={(event) => {
          scrollRowDragRef.current = {
            pointerId: event.pointerId,
            active: true,
            moved: false,
            startX: event.clientX,
            startOffset: scrollTrackOffset,
          };
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {}
        }}
        onPointerMove={(event) => {
          const drag = scrollRowDragRef.current;
          if (!drag.active || drag.pointerId !== event.pointerId) {
            return;
          }
          const deltaX = event.clientX - drag.startX;
          if (Math.abs(deltaX) > 4) {
            drag.moved = true;
            suppressScrollRowClickRef.current = true;
          }
          const nextOffset = Math.max(0, Math.min(maxScrollTrackOffset, drag.startOffset - deltaX));
          setScrollTrackOffset(nextOffset);
        }}
        onPointerUp={(event) => {
          if (scrollRowDragRef.current.pointerId === event.pointerId) {
            scrollRowDragRef.current.active = false;
            scrollRowDragRef.current.pointerId = -1;
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {}
            if (suppressScrollRowClickRef.current) {
              window.setTimeout(() => {
                suppressScrollRowClickRef.current = false;
              }, 120);
            }
          }
        }}
        onPointerCancel={(event) => {
          scrollRowDragRef.current.active = false;
          scrollRowDragRef.current.pointerId = -1;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {}
          if (suppressScrollRowClickRef.current) {
            window.setTimeout(() => {
              suppressScrollRowClickRef.current = false;
            }, 120);
          }
        }}
      >
        <div
          ref={scrollTrackRef}
          style={{
            display: 'inline-flex',
            gap: `${QUICK_BAR_ROW_GAP}px`,
            minWidth: 'max-content',
            alignItems: 'center',
            transform: `translateX(-${scrollTrackOffset}px)`,
            willChange: 'transform',
          }}
        >
          {scrollActions.map((action) => (
            <button
              key={action.id}
              tabIndex={-1}
              onClick={(event) => {
                if (suppressScrollRowClickRef.current) {
                  return;
                }
                blurCurrentTarget(event.currentTarget);
                onSendSequence?.(action.sequence);
              }}
              style={{
                minHeight: '44px',
                minWidth: action.label.length > 3 ? '58px' : '44px',
                padding: '0 12px',
                border: 'none',
                borderRadius: '14px',
                backgroundColor: 'rgba(31, 38, 53, 0.68)',
                color: '#fff',
                fontSize: action.label.length > 2 ? '13px' : '18px',
                fontWeight: 700,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatSnippetPreview(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 24);
}

function lightEditorInputStyle() {
  return {
    ...editorInputStyle(),
    backgroundColor: '#f4f6fb',
    border: '1px solid rgba(23, 27, 45, 0.1)',
    color: mobileTheme.colors.lightText,
  } as const;
}

function overlayIconButton(disabled: boolean) {
  return {
    width: '32px',
    height: '32px',
    borderRadius: '999px',
    border: 'none',
    backgroundColor: disabled ? '#f3f5f9' : '#eef2f8',
    color: disabled ? '#c3cad7' : mobileTheme.colors.lightText,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 700,
    flexShrink: 0,
  } as const;
}

function overlayTextButton(backgroundColor: string, color: string) {
  return {
    minHeight: '34px',
    padding: '0 12px',
    borderRadius: '999px',
    border: 'none',
    backgroundColor,
    color,
    cursor: 'pointer',
    fontWeight: 700,
    flexShrink: 0,
  } as const;
}

function floatingPillButton(backgroundColor: string, color: string) {
  return {
    minHeight: '34px',
    padding: '0 12px',
    borderRadius: '999px',
    border: 'none',
    backgroundColor,
    color,
    cursor: 'pointer',
    fontWeight: 700,
    flexShrink: 0,
  } as const;
}
