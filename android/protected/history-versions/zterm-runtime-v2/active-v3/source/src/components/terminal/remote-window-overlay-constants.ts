/**
 * Remote window overlay 常量（client.remote_window_overlay）。
 * 从 RemoteWindowOverlay.tsx 拆出的纯常量子模块，禁止在组件内散落 magic number。
 */

export const FLOATING_OVERLAY_VIEWPORT_MARGIN_PX = 8;
export const FLOATING_OVERLAY_TOP_SAFE_MARGIN_PX = 48;
export const REMOTE_WINDOW_FLOATING_BOTTOM_BASE_PX = 118;
export const FLOATING_ENTRY_VIEWPORT_MARGIN_PX = 10;
export const FLOATING_ENTRY_TOP_MARGIN_PX = 28;
export const FLOATING_OVERLAY_MIN_WIDTH_PX = 168;
export const FLOATING_OVERLAY_MAX_WIDTH_PX = 560;
export const FLOATING_OVERLAY_TOOLBAR_ESTIMATE_PX = 50;
export const REMOTE_WINDOW_FULLSCREEN_MIN_SCALE = 1;
export const REMOTE_WINDOW_FULLSCREEN_MAX_SCALE = 4;
export const REMOTE_WINDOW_FULLSCREEN_PAN_TAP_THRESHOLD_PX = 8;
export const REMOTE_WINDOW_SECOND_FINGER_UPGRADE_PX = 8;

export const REMOTE_WINDOW_CATALOG_UI_TIMEOUT_MS = 20_000;
export const REMOTE_WINDOW_DUAL_STREAM_SWITCH_TIMEOUT_MS = 3_000;
export const REMOTE_WINDOW_CATALOG_PROJECTION_CACHE_TTL_MS = 60_000;
export const REMOTE_WINDOW_ACTIVE_CATALOG_SYNC_INTERVAL_MS = 5_000;
export const REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS = 15_000;
export const REMOTE_WINDOW_THUMBNAIL_MAX_REQUESTS_PER_TICK = 1;

export const REMOTE_WINDOW_DOUBLE_TAP_MS = 300;
export const REMOTE_WINDOW_DOUBLE_TAP_SLOP_PX = 8;

export type RemoteWindowInputMode = 'touch' | 'mouse';

export type FloatingResizeAnchor = 'left-bottom' | 'right-bottom';
