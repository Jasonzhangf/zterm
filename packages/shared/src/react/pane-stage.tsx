/**
 * 跨平台 PaneStage 容器。
 *
 * 设计原则：
 * - 核心是 **horizontal split flex container**，和具体的尺寸/手势无关
 * - pane 之间的 divider 在 desktop/tablet 显示 drag handle，phone 隐藏
 * - pane 比例 (pane.size) 由调用方传入（workspace-model normalizePaneSizes 已经处理）
 *
 * 平台差异仅在 onPointerDown onDivider / 是否显示 drag handle 上：
 * - phone: divider hit area 18px，但视觉透明
 * - desktop/tablet: divider 始终可见 + drag handle
 *
 * 核心算法（比例变更、pane 添加/删除）由 workspace-model 负责
 * 本组件不持有 workspace 状态，只渲染 + 暴露 drag 事件
 */

import type { CSSProperties, ReactNode } from 'react';
import { resolvePaneProfile, type PanePlatform, type PaneProfile, type PaneStageTokens } from './pane-profile';

export interface PaneSlotDefinition<TTabId extends string = string> {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  size: number;
  isActive: boolean;
  hideHeader?: boolean;
  render: () => ReactNode;
  /**
   * pane 内 tab 列表的 id 列表（用于 swipe gesture 路由）
   */
  tabIds: TTabId[];
  activeTabId: TTabId | null;
}

export interface PaneStageDragEvent {
  sourcePaneId: string;
  targetPaneId: string;
  ratio: number;
}

interface PaneStageProps<TTabId extends string> {
  platform: PanePlatform;
  splitVisible: boolean;
  slots: PaneSlotDefinition<TTabId>[];
  topInsetPx?: number;
  landscape?: boolean;
  /**
   * desktop/tablet 拖拽 divider 改 pane 比例时回调
   * 父组件负责把 ratio 写回 workspace state
   */
  onPaneRatioChange?: (event: PaneStageDragEvent) => void;
  /**
   * desktop/tablet 点击 pane（激活焦点）
   * phone 通过 tab 点击自然激活
   */
  onActivatePane?: (paneId: string) => void;
}

const STAGE_BASE_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'stretch',
  position: 'relative',
};

const PANE_BASE_STYLE: CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  boxSizing: 'border-box',
  position: 'relative',
};

function PaneFrame<TTabId extends string>({
  slot,
  profile,
  onActivate,
}: {
  slot: PaneSlotDefinition<TTabId>;
  profile: PaneProfile;
  onActivate?: (paneId: string) => void;
}) {
  const stageTokens: PaneStageTokens = profile.stage;
  const frameStyle: CSSProperties = {
    ...PANE_BASE_STYLE,
    flex: `${Math.max(0.01, slot.size)} 1 0%`,
    borderRadius: stageTokens.paneRadius,
    overflow: 'hidden',
    outline: 'none',
    backgroundColor: slot.isActive ? '#05070b' : '#252a31',
    cursor: profile.gesture.dragResizeEnabled && !slot.isActive ? 'pointer' : undefined,
  };

  return (
    <section
      data-testid="pane-stage-frame"
      data-pane-id={slot.id}
      data-pane-active={slot.isActive ? 'true' : 'false'}
      onPointerDown={() => onActivate?.(slot.id)}
      style={frameStyle}
    >
      {slot.render()}
    </section>
  );
}

function PaneDivider<TTabId extends string>({
  sourceSlot,
  targetSlot,
  profile,
  onPaneRatioChange,
  onActivatePane,
}: {
  sourceSlot: PaneSlotDefinition<TTabId>;
  targetSlot: PaneSlotDefinition<TTabId>;
  profile: PaneProfile;
  onPaneRatioChange?: (event: PaneStageDragEvent) => void;
  onActivatePane?: (paneId: string) => void;
}) {
  const hitPx = profile.gesture.dividerHitPx;
  const visible = profile.gesture.dragResizeEnabled;

  const containerStyle: CSSProperties = {
    width: `${hitPx}px`,
    flexShrink: 0,
    alignSelf: 'stretch',
    position: 'relative',
    cursor: visible ? 'col-resize' : 'default',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const lineStyle: CSSProperties = visible
    ? {
        width: '1px',
        flex: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.12)',
      }
    : {
        width: '1px',
        flex: 1,
        backgroundColor: 'transparent',
      };

  const handleStyle: CSSProperties = visible
    ? {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '1px',
        height: '100%',
        borderRadius: '999px',
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
        pointerEvents: 'none',
      }
    : { display: 'none' };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      data-testid="pane-stage-divider"
      data-divider-source={sourceSlot.id}
      data-divider-target={targetSlot.id}
      onPointerDown={(event) => {
        if (!visible || !onPaneRatioChange) {
          onActivatePane?.(sourceSlot.id);
          return;
        }
        event.preventDefault();
        const startX = event.clientX;
        const startRatio = sourceSlot.size;
        const targetRatio = targetSlot.size;
        const pairRatio = startRatio + targetRatio;
        const minPaneRatio = Math.min(0.1, pairRatio / 2);
        const stage = event.currentTarget.closest('[data-testid="pane-stage-split"]') as HTMLElement | null;
        const stageWidth = stage?.getBoundingClientRect().width ?? 0;
        const frames = stage
          ? Array.from(stage.querySelectorAll<HTMLElement>('[data-testid="pane-stage-frame"]'))
          : [];
        const sourceFrame = frames.find((frame) => frame.dataset.paneId === sourceSlot.id);
        const targetFrame = frames.find((frame) => frame.dataset.paneId === targetSlot.id);
        const applyLiveFlex = (nextSource: number, nextTarget: number) => {
          if (!sourceFrame || !targetFrame) {
            return;
          }
          sourceFrame.style.flex = `${Math.max(0.01, nextSource)} 1 0%`;
          targetFrame.style.flex = `${Math.max(0.01, nextTarget)} 1 0%`;
        };
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        const move = (e: PointerEvent) => {
          if (!stageWidth) {
            return;
          }
          const delta = (e.clientX - startX) / stageWidth;
          const nextSource = Math.max(minPaneRatio, Math.min(pairRatio - minPaneRatio, startRatio + delta));
          const nextTarget = pairRatio - nextSource;
          applyLiveFlex(nextSource, nextTarget);
          onPaneRatioChange({
            sourcePaneId: sourceSlot.id,
            targetPaneId: targetSlot.id,
            ratio: nextSource / (nextSource + nextTarget),
          });
        };
        const up = () => {
          document.body.style.userSelect = previousUserSelect;
          document.body.style.cursor = previousCursor;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      style={containerStyle}
    >
      <div style={lineStyle} />
      <div style={handleStyle} />
    </div>
  );
}

export function PaneStage<TTabId extends string = string>({
  platform,
  splitVisible,
  slots,
  topInsetPx = 0,
  landscape = false,
  onPaneRatioChange,
  onActivatePane,
}: PaneStageProps<TTabId>) {
  const profile = resolvePaneProfile({ platform, splitVisible, topInsetPx, landscape });

  if (!splitVisible) {
    // single-pane: render only first slot
    const first = slots[0];
    if (!first) {
      return null;
    }
    return (
      <main
        data-testid="pane-stage-single"
        data-stage-mode={profile.mode}
        style={{
          ...STAGE_BASE_STYLE,
          flexDirection: 'column',
          margin: profile.stage.outerMargin,
          borderRadius: profile.stage.containerRadius,
        }}
      >
        <PaneFrame
          slot={first}
          profile={profile}
          onActivate={onActivatePane}
        />
      </main>
    );
  }

  return (
    <main
      data-testid="pane-stage-split"
      data-stage-mode={profile.mode}
      style={{
        ...STAGE_BASE_STYLE,
        gap: profile.stage.paneGap,
        margin: profile.stage.outerMargin,
        padding: profile.stage.rowBottomPadding,
      }}
    >
      {slots.map((slot, index) => {
        const next = slots[index + 1];
        return (
          <div
            key={slot.id}
            style={{ display: 'contents' }}
          >
            <PaneFrame
              slot={slot}
              profile={profile}
              onActivate={onActivatePane}
            />
            {next ? (
              <PaneDivider
                sourceSlot={slot}
                targetSlot={next}
                profile={profile}
                onPaneRatioChange={onPaneRatioChange}
                onActivatePane={onActivatePane}
              />
            ) : null}
          </div>
        );
      })}
    </main>
  );
}
