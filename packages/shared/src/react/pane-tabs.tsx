/**
 * pane 内 tab 行的跨平台抽象。
 *
 * 核心不变量：
 * - 每个 pane 维护自己的 tab 列表与 activeTabId
 * - tab 行的渲染与手势绑定（tap / long-press / double-tap / right-click / horizontal swipe）
 *   只发生在调用方传入的 callback 上
 * - 平台差异由 pane-profile 决定：
 *   - phone: long-press 唤起 pane-menu，horizontal swipe 切 tab
 *   - desktop: right-click 唤起 pane-menu，ctrl+pageup/pagedown 切 tab
 *   - tablet: 两者皆支持
 *
 * 不持有 workspace 状态，只把事件抛回 callback
 */

import type { CSSProperties, ReactNode } from 'react';
import type { PanePlatform, PaneProfile, PaneHeaderTokens } from './pane-profile';

const PLUS_LONG_PRESS_MS = 680;

export interface PaneTabDescriptor {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  isActive: boolean;
  customName?: string;
  isResolvedRelay?: boolean;
}

export interface PaneHeaderContextMenuAction {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export interface PaneTabsProps {
  platform: PanePlatform;
  profile: PaneProfile;
  paneId: string;
  paneIndex: number;
  isActivePane: boolean;
  tabs: PaneTabDescriptor[];
  backButton?: {
    onBack: () => void;
  };
  plusButton?: {
    onQuickNew: () => void;
    onOpenTabManager: () => void;
  };
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onActivatePane: (paneId: string) => void;
  onLongPressTab?: (tabId: string, anchor: { left: number; top: number }) => void;
  onContextMenuTab?: (tabId: string, anchor: { left: number; top: number }) => void;
  onRenameTab?: (tabId: string) => void;
  onForceRelay?: (tabId: string) => void;
  onUseAuto?: (tabId: string) => void;
  onContextMenuPane?: (
    paneId: string,
    anchor: { left: number; top: number },
  ) => void;
  renderTabExtras?: (tab: PaneTabDescriptor) => ReactNode;
}

const baseTabStyle = (header: PaneHeaderTokens, active: boolean): CSSProperties => ({
  flexShrink: 0,
  width: '100%',
  minWidth: active ? header.tabMinWidthActive : header.tabMinWidthIdle,
  maxWidth: active ? header.tabMaxWidthActive : header.tabMaxWidthIdle,
  minHeight: header.tabMinHeight,
  borderRadius: header.tabRadius,
  outline: 'none',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  backgroundColor: active ? 'rgba(59, 122, 255, 0.18)' : 'rgba(255, 255, 255, 0.04)',
  color: active ? '#cfe0ff' : 'rgba(231, 238, 252, 0.92)',
  fontSize: header.tabFontSize,
  fontWeight: 700,
  padding: active ? header.tabActivePadding : header.tabIdlePadding,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
  userSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
});

export function PaneTabs(props: PaneTabsProps) {
  const {
    platform,
    profile,
    paneId,
    paneIndex,
    isActivePane,
    tabs,
    backButton,
    plusButton,
    onSelectTab,
    onCloseTab,
    onActivatePane,
    onLongPressTab,
    onContextMenuTab,
    onRenameTab,
    onForceRelay,
    onUseAuto,
    onContextMenuPane,
    renderTabExtras,
  } = props;
  const header = profile.header;
  const splitVisible = profile.splitVisible;
  const isDesktopSplit = profile.mode === 'desktop-split';

  return (
    <div
      data-testid={`pane-tabs-${paneId}`}
      data-pane-index={paneIndex}
      data-pane-active={isActivePane ? 'true' : 'false'}
      style={{ padding: header.outerPadding }}
    >
      <div
        style={{ display: 'flex', alignItems: 'stretch', gap: header.rowGap, marginTop: 0 }}
      >
        {backButton ? (
          <button
            data-testid={`pane-back-${paneId}`}
            onClick={backButton.onBack}
            tabIndex={-1}
            onFocus={(event) => event.currentTarget.blur()}
            onContextMenu={
              platform !== 'phone'
                ? (event) => {
                    event.preventDefault();
                    onContextMenuPane?.(paneId, { left: event.clientX, top: event.clientY });
                  }
                : undefined
            }
            style={{
              width: header.backButtonSize,
              height: header.backButtonSize,
              borderRadius: header.backButtonRadius,
              border: 'none',
              outline: 'none',
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              color: 'inherit',
              fontSize: header.backButtonFontSize,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            ‹
          </button>
        ) : null}

        <div
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onActivatePane(paneId);
            }
          }}
          style={{
            flex: '1 1 0%',
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: header.paneGap,
            padding: header.panePadding,
            borderRadius: header.paneRadius,
            border: splitVisible && !isDesktopSplit
              ? `1px solid ${isActivePane ? 'rgba(83, 139, 255, 0.38)' : 'rgba(255,255,255,0.06)'}`
              : 'none',
            backgroundColor: splitVisible && !isDesktopSplit
              ? (isActivePane ? 'rgba(19, 28, 43, 0.92)' : 'rgba(16, 21, 31, 0.82)')
              : 'transparent',
          }}
        >
          {profile.splitVisible ? (
            <span
              data-testid={`pane-badge-${paneId}`}
              style={{
                minWidth: header.paneBadgeMinWidth,
                height: header.paneBadgeHeight,
                borderRadius: '999px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 6px',
                fontSize: '9px',
                fontWeight: 900,
                backgroundColor: isActivePane ? 'rgba(113, 164, 255, 0.16)' : 'rgba(255,255,255,0.06)',
                color: isActivePane ? '#8db7ff' : 'rgba(231,238,252,0.72)',
                flexShrink: 0,
                lineHeight: 1,
                letterSpacing: '0.01em',
              }}
              title={`Pane ${paneIndex + 1}`}
            >
              {`P${paneIndex + 1}`}
            </span>
          ) : null}

          <div
            tabIndex={-1}
            onFocus={(event) => event.currentTarget.blur()}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: header.paneGap,
              overflowX: 'auto',
              overflowY: 'hidden',
              scrollbarWidth: 'none',
              WebkitOverflowScrolling: 'touch',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
              outline: 'none',
              boxShadow: 'none',
              userSelect: 'none',
              minHeight: header.paneScrollerMinHeight,
            }}
          >
            {tabs.map((tab) => (
              <PaneTabButton
                key={tab.id}
                platform={platform}
                profile={profile}
                tab={tab}
                onSelect={onSelectTab}
                onClose={onCloseTab}
                onLongPress={onLongPressTab}
                onContextMenu={onContextMenuTab}
                onRename={onRenameTab}
                onForceRelay={onForceRelay}
                onUseAuto={onUseAuto}
                renderExtras={renderTabExtras}
              />
            ))}
          </div>

          {plusButton ? (
            <PanePlusButton paneId={paneId} header={header} plusButton={plusButton} platform={platform} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PanePlusButton({
  paneId,
  header,
  plusButton,
  platform,
}: {
  paneId: string;
  header: PaneHeaderTokens;
  plusButton: NonNullable<PaneTabsProps['plusButton']>;
  platform: PanePlatform;
}) {
  let timer: number | null = null;
  let longPressTriggered = false;
  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const start = () => {
    clear();
    longPressTriggered = false;
    timer = window.setTimeout(() => {
      longPressTriggered = true;
      plusButton.onOpenTabManager();
    }, PLUS_LONG_PRESS_MS);
  };
  const end = () => clear();

  return (
    <button
      data-testid={`pane-plus-${paneId}`}
      type="button"
      onMouseDown={start}
      onMouseUp={end}
      onMouseLeave={end}
      onTouchStart={start}
      onTouchEnd={end}
      onTouchCancel={end}
      onClick={(event) => {
        if (longPressTriggered) {
          longPressTriggered = false;
          event.preventDefault();
          return;
        }
        plusButton.onQuickNew();
      }}
      tabIndex={-1}
      onFocus={(event) => event.currentTarget.blur()}
      onContextMenu={
        platform !== 'phone'
          ? (event) => {
              event.preventDefault();
              plusButton.onOpenTabManager();
            }
          : undefined
      }
      style={{
        width: header.plusButtonSize,
        height: header.plusButtonSize,
        borderRadius: header.plusButtonRadius,
        border: 'none',
        outline: 'none',
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        color: 'inherit',
        fontSize: header.plusButtonFontSize,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      +
    </button>
  );
}

interface PaneTabButtonProps {
  platform: PanePlatform;
  profile: PaneProfile;
  tab: PaneTabDescriptor;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onLongPress?: (tabId: string, anchor: { left: number; top: number }) => void;
  onContextMenu?: (tabId: string, anchor: { left: number; top: number }) => void;
  onRename?: (tabId: string) => void;
  /** reserved for relay path control; not rendered in cross-platform baseline */
  onForceRelay?: (tabId: string) => void;
  /** reserved for auto path control; not rendered in cross-platform baseline */
  onUseAuto?: (tabId: string) => void;
  renderExtras?: (tab: PaneTabDescriptor) => ReactNode;
}

function PaneTabButton({
  platform,
  profile,
  tab,
  onSelect,
  onClose,
  onLongPress,
  onContextMenu,
  onRename,
  onForceRelay: _onForceRelay,
  onUseAuto: _onUseAuto,
  renderExtras,
}: PaneTabButtonProps) {
  const header = profile.header;
  const longPressMs = profile.gesture.longPressMs;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;
  let suppressClickUntil = 0;

  return (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        width: tab.isActive ? header.tabMaxWidthActive : header.tabMinWidthIdle,
      }}
    >
      <button
        data-tab-id={tab.id}
        data-tab-active={tab.isActive ? 'true' : 'false'}
        tabIndex={-1}
        onFocus={(event) => event.currentTarget.blur()}
        onMouseDown={(event) => {
          if (event.button === 2) return;
          if (onLongPress) {
            const target = event.currentTarget;
            const timer = window.setTimeout(() => {
              const rect = target.getBoundingClientRect();
              onLongPress(tab.id, {
                left: Math.round(rect.left),
                top: Math.round(rect.bottom + 6),
              });
            }, longPressMs);
            const clear = () => window.clearTimeout(timer);
            target.addEventListener('mouseup', clear, { once: true });
            target.addEventListener('mouseleave', clear, { once: true });
          }
        }}
        onTouchStart={
          platform === 'phone' && onLongPress
            ? (event) => {
                const target = event.currentTarget;
                const touch = event.touches[0];
                if (!touch) return;
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                touchMoved = false;
                if (event.touches.length >= 2 && tab.isActive) {
                  event.preventDefault();
                  onLongPress(tab.id, {
                    left: Math.round(touch.clientX),
                    top: Math.round(touch.clientY),
                  });
                  return;
                }
                const timer = window.setTimeout(() => {
                  const rect = target.getBoundingClientRect();
                  onLongPress(tab.id, {
                    left: Math.round(rect.left),
                    top: Math.round(rect.bottom + 6),
                  });
                }, longPressMs);
                const clear = () => window.clearTimeout(timer);
                target.addEventListener('touchend', clear, { once: true });
                target.addEventListener('touchcancel', clear, { once: true });
              }
            : undefined
        }
        onTouchMove={
          platform === 'phone'
            ? (event) => {
                const touch = event.touches[0];
                if (!touch || touchMoved) return;
                if (Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY) < profile.gesture.swipeLockPx) {
                  return;
                }
                touchMoved = true;
                suppressClickUntil = Date.now() + 600;
              }
            : undefined
        }
        onContextMenu={
          platform !== 'phone' && onContextMenu
            ? (event) => {
                event.preventDefault();
                onContextMenu(tab.id, { left: event.clientX, top: event.clientY });
              }
            : undefined
        }
        onDoubleClick={
          platform !== 'phone' && onRename ? () => onRename(tab.id) : undefined
        }
        onClick={() => {
          if (platform === 'phone' && (touchMoved || Date.now() < suppressClickUntil)) {
            touchMoved = false;
            return;
          }
          onSelect(tab.id);
        }}
        style={baseTabStyle(header, tab.isActive)}
        title={
          platform === 'phone'
            ? 'Tap: switch · Long press tab: pane menu · Two-finger tap current tab: move menu'
            : 'Click: switch · Right-click: pane menu · Double-click: rename'
        }
      >
        {profile.splitVisible ? (
          <span
            style={{
              minWidth: '16px',
              height: '16px',
              borderRadius: '999px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              lineHeight: 1,
              backgroundColor: 'rgba(31, 214, 122, 0.18)',
              color: '#7ff1cc',
              flexShrink: 0,
            }}
          >
            {tab.badge || '·'}
          </span>
        ) : null}
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {tab.customName || tab.title}
          </span>
        </span>
      </button>
      {renderExtras?.(tab)}
      {tab.isActive ? (
        <button
          type="button"
          aria-label="关闭当前 tab"
          data-testid={`pane-tab-close-${tab.id}`}
          tabIndex={-1}
          onFocus={(event) => event.currentTarget.blur()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab.id);
          }}
          onTouchEnd={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onClose(tab.id);
          }}
          style={{
            position: 'absolute',
            top: '50%',
            right: header.closeButtonRight,
            transform: 'translateY(-50%)',
            width: '20px',
            height: '20px',
            borderRadius: '999px',
            border: 'none',
            outline: 'none',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255, 255, 255, 0.14)',
            color: 'inherit',
            fontSize: '13px',
            lineHeight: 1,
            fontWeight: 900,
            zIndex: 2,
            pointerEvents: 'auto',
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
