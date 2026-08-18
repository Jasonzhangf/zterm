# Tab Swipe Grid Redesign - Static Preview

## 设计目标

| 维度 | 当前 | 新设计 |
|------|------|--------|
| 垂直空间 | tab bar 永久占用 ~52px | 0px（完全隐藏） |
| 切换方式 | 点击 tab 顶部行 | 右滑手势呼出 |
| 展示形式 | 横向滚动 tab 行 | 纵向网格布局 |
| 分屏信息 | 顶部 badge + pane 分组 | 每个 card 显示 pane 归属 |
| 分屏切换 | tap pane 区域 | swipe 切换 pane / 同一个 grid 内选 |

## 交互契约

```
状态机：
  HIDDEN (默认)
    —右滑 ≥40px 或长按屏幕边缘 → REVEALING
  REVEALING
    —松手 <120ms 且滑距 <40px → HIDDEN
    —松手 ≥120ms 或滑距 ≥40px → REVEALED
  REVEALED
    —tap grid 外任意处 → HIDDEN
    —tap session card → switch session → HIDDEN
    —swipe left → HIDDEN (带 animate)
```

## 静态预览（可粘贴到浏览器）

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Tab Swipe Grid Preview</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #080c12;
  --surface: rgba(16, 22, 34, 0.97);
  --border: rgba(255,255,255,0.08);
  --accent: #5393ff;
  --accent-dim: rgba(83,147,255,0.18);
  --text: #cfe0ff;
  --text-dim: rgba(200,215,255,0.6);
  --danger: #ff5f6d;
  --success: #3fe1a0;
  --pane1: rgba(83,147,255,0.25);
  --pane2: rgba(255,150,83,0.25);
  --radius: 14px;
  --radius-sm: 10px;
  --sheet-peek: 0px; /* peek height when hidden */
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
  height: 100dvh;
  overflow: hidden;
  -webkit-user-select: none;
  user-select: none;
}

/* ─── Full Terminal Stage ─── */
.terminal-stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* Fake terminal content */
.terminal-content {
  position: absolute;
  inset: 0;
  padding: 16px;
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: rgba(200,220,255,0.85);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-y: auto;
  z-index: 1;
}

.terminal-content::-webkit-scrollbar { width: 0; }

/* Fake prompt line */
.prompt-line { color: var(--success); }
.prompt-cursor {
  display: inline-block;
  width: 8px; height: 15px;
  background: rgba(200,230,255,0.7);
  vertical-align: text-bottom;
  animation: blink 1.1s step-end infinite;
}
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

/* ─── Swipe Sheet (Session Grid) ─── */
.swipe-sheet {
  position: fixed;
  inset: 0;
  z-index: 100;
  pointer-events: none;
}

/* Dim overlay behind sheet */
.swipe-sheet-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.45);
  opacity: 0;
  transition: opacity 280ms ease;
  pointer-events: none;
}

/* The sheet panel (slides from right) */
.swipe-sheet-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(340px, 88vw);
  background: var(--surface);
  border-left: 1px solid var(--border);
  transform: translateX(100%);
  transition: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: none;
  box-shadow: -16px 0 48px rgba(0,0,0,0.55);
}

.swipe-sheet-panel.revealed {
  pointer-events: auto;
}

.swipe-sheet-overlay.revealed {
  opacity: 1;
  pointer-events: auto;
}

/* Swipe drag handle (left edge of panel) */
.swipe-drag-handle {
  position: absolute;
  top: 50%;
  left: 0;
  transform: translate(-50%, -50%);
  width: 6px;
  height: 60px;
  background: rgba(255,255,255,0.15);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.swipe-drag-handle::after {
  content: '⋮';
  color: rgba(255,255,255,0.3);
  font-size: 14px;
  writing-mode: vertical-rl;
  letter-spacing: 2px;
}

/* ─── Sheet Header ─── */
.sheet-header {
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.sheet-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 10px;
}

.sheet-pane-tabs {
  display: flex;
  gap: 8px;
}

.pane-tab-btn {
  flex: 1;
  padding: 7px 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 160ms ease;
}

.pane-tab-btn.active {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}

.pane-tab-btn .pane-dot {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: middle;
}

.pane-tab-btn[data-pane="1"] .pane-dot { background: #5393ff; }
.pane-tab-btn[data-pane="2"] .pane-dot { background: #ff9640; }

/* ─── Session Grid ─── */
.sheet-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  -webkit-overflow-scrolling: touch;
}

.sheet-content::-webkit-scrollbar { width: 0; }

/* Section label */
.section-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(200,215,255,0.35);
  padding: 0 2px;
  margin-bottom: 8px;
  margin-top: 4px;
}

.session-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

/* Session Card */
.session-card {
  position: relative;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 12px 10px;
  cursor: pointer;
  transition: all 160ms ease;
  min-height: 80px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  -webkit-tap-highlight-color: transparent;
}

.session-card:active {
  background: rgba(255,255,255,0.08);
  transform: scale(0.97);
}

.session-card.active {
  border-color: var(--accent);
  background: var(--accent-dim);
}

.session-card.pane-1 { border-left: 3px solid #5393ff; }
.session-card.pane-2 { border-left: 3px solid #ff9640; }

.session-card .pane-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 9px;
  font-weight: 900;
  padding: 2px 5px;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  color: rgba(200,215,255,0.5);
}

.session-card.pane-1 .pane-badge { background: rgba(83,147,255,0.2); color: #5393ff; }
.session-card.pane-2 .pane-badge { background: rgba(255,150,64,0.2); color: #ff9640; }

.session-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 28px;
}

.session-host {
  font-size: 10px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-status {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}

.status-dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}

.status-dot.disconnected { background: rgba(255,95,109,0.7); }
.status-dot.connecting { background: rgba(255,190,83,0.8); animation: pulse 1s ease infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.status-label {
  font-size: 10px;
  color: var(--text-dim);
}

.session-card.active .status-dot { background: var(--accent); }

/* Close button on hover/active */
.session-card .close-btn {
  position: absolute;
  bottom: 8px;
  right: 8px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: rgba(255,95,109,0.2);
  border: none;
  color: rgba(255,150,155,0.8);
  font-size: 13px;
  font-weight: 900;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms;
  display: flex; align-items: center; justify-content: center;
  -webkit-tap-highlight-color: transparent;
}

.session-card:hover .close-btn,
.session-card:active .close-btn {
  opacity: 1;
}

.close-btn:hover {
  background: rgba(255,95,109,0.4) !important;
}

/* ─── Bottom Action Bar ─── */
.sheet-actions {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.action-btn {
  flex: 1;
  padding: 11px 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.06);
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: all 140ms ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  -webkit-tap-highlight-color: transparent;
}

.action-btn:active {
  background: rgba(255,255,255,0.12);
  transform: scale(0.97);
}

.action-btn.primary {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}

.action-btn.primary:active {
  background: rgba(83,147,255,0.3);
}

/* ─── Swipe Edge Indicator (peek) ─── */
.swipe-hint {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  padding: 10px 6px;
  border-radius: 0 8px 8px 0;
  background: rgba(83,147,255,0.15);
  border: 1px solid rgba(83,147,255,0.3);
  border-left: none;
  color: rgba(83,147,255,0.7);
  font-size: 11px;
  font-weight: 700;
  writing-mode: vertical-rl;
  letter-spacing: 1px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 400ms ease;
  pointer-events: none;
  z-index: 50;
}

.swipe-hint.visible {
  opacity: 1;
  pointer-events: auto;
}

/* ─── Quick Switch Dot Row (bottom of screen) ─── */
.quick-switch-bar {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  align-items: center;
  z-index: 50;
  opacity: 0;
  transition: opacity 300ms ease;
  pointer-events: none;
  background: rgba(8,12,18,0.7);
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
}

.quick-switch-bar.visible {
  opacity: 1;
  pointer-events: auto;
}

.quick-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: rgba(255,255,255,0.2);
  cursor: pointer;
  transition: all 200ms ease;
  -webkit-tap-highlight-color: transparent;
}

.quick-dot.active {
  background: var(--accent);
  transform: scale(1.3);
}

.quick-dot.pane1 { background: rgba(83,147,255,0.5); }
.quick-dot.pane2 { background: rgba(255,150,83,0.5); }

/* ─── Swipe Progress Bar ─── */
.swipe-progress-track {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: transparent;
  z-index: 200;
  pointer-events: none;
}

.swipe-progress-fill {
  height: 100%;
  background: var(--accent);
  width: 0%;
  transition: width 0ms linear;
}

/* ─── State indicator in terminal content ─── */
.state-indicator {
  position: absolute;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(16,22,34,0.88);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 11px;
  color: var(--text-dim);
  z-index: 50;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 300ms ease;
}

.state-indicator.visible {
  opacity: 1;
}
</style>
</head>
<body>

<!-- Terminal Stage (background) -->
<div class="terminal-stage" id="stage">
  <div class="terminal-content" id="terminalContent">
    <div class="prompt-line">fanzhang@macstudio ~ % <span class="prompt-cursor"></span></div>
  </div>

  <!-- Swipe progress bar -->
  <div class="swipe-progress-track">
    <div class="swipe-progress-fill" id="swipeProgress"></div>
  </div>

  <!-- Swipe hint (left edge, peek when idle) -->
  <div class="swipe-hint visible" id="swipeHint">← Sessions</div>

  <!-- Quick switch dots (bottom, visible when sheet hidden) -->
  <div class="quick-switch-bar" id="quickBar">
    <div class="quick-dot pane1 active" data-session="s1" title="demo (P1)"></div>
    <div class="quick-dot pane1" data-session="s2" title="android-dev (P1)"></div>
    <div class="quick-dot pane2" data-session="s3" title="server-prod (P2)"></div>
  </div>

  <!-- State indicator -->
  <div class="state-indicator" id="stateIndicator">Swipe right →</div>
</div>

<!-- Session Grid Sheet -->
<div class="swipe-sheet" id="swipeSheet">
  <div class="swipe-sheet-overlay" id="sheetOverlay"></div>
  <div class="swipe-sheet-panel" id="sheetPanel">

    <!-- Drag handle -->
    <div class="swipe-drag-handle"></div>

    <!-- Header -->
    <div class="sheet-header">
      <div class="sheet-title">Sessions</div>
      <div class="sheet-pane-tabs">
        <button class="pane-tab-btn active" data-pane="1" id="paneTab1">
          <span class="pane-dot"></span>P1 · 2 tabs
        </button>
        <button class="pane-tab-btn" data-pane="2" id="paneTab2">
          <span class="pane-dot"></span>P2 · 1 tab
        </button>
      </div>
    </div>

    <!-- Session Grid -->
    <div class="sheet-content" id="sheetContent">

      <!-- P1 sessions -->
      <div class="section-label">Pane 1</div>
      <div class="session-grid" id="gridPane1">
        <div class="session-card active pane-1" data-session="s1">
          <div class="pane-badge">P1</div>
          <div>
            <div class="session-name">demo</div>
            <div class="session-host">100.127.23.27</div>
          </div>
          <div class="session-status">
            <div class="status-dot"></div>
            <span class="status-label">Connected</span>
          </div>
          <button class="close-btn" onclick="event.stopPropagation(); closeSession('s1')">×</button>
        </div>

        <div class="session-card pane-1" data-session="s2">
          <div class="pane-badge">P1</div>
          <div>
            <div class="session-name">android-dev</div>
            <div class="session-host">mac.local:3333</div>
          </div>
          <div class="session-status">
            <div class="status-dot"></div>
            <span class="status-label">Connected</span>
          </div>
          <button class="close-btn" onclick="event.stopPropagation(); closeSession('s2')">×</button>
        </div>
      </div>

      <!-- P2 sessions -->
      <div class="section-label" style="margin-top:14px;">Pane 2</div>
      <div class="session-grid" id="gridPane2">
        <div class="session-card pane-2" data-session="s3">
          <div class="pane-badge">P2</div>
          <div>
            <div class="session-name">server-prod</div>
            <div class="session-host">192.168.1.100</div>
          </div>
          <div class="session-status">
            <div class="status-dot"></div>
            <span class="status-label">Connected</span>
          </div>
          <button class="close-btn" onclick="event.stopPropagation(); closeSession('s3')">×</button>
        </div>
      </div>

      <!-- Disconnected / archived -->
      <div class="section-label" style="margin-top:14px;">已断开</div>
      <div class="session-grid">
        <div class="session-card" data-session="s4" style="opacity:0.5">
          <div>
            <div class="session-name">mac-mini</div>
            <div class="session-host">100.64.22.11</div>
          </div>
          <div class="session-status">
            <div class="status-dot disconnected"></div>
            <span class="status-label">Disconnected</span>
          </div>
        </div>
        <div class="session-card" data-session="s5" style="opacity:0.5">
          <div>
            <div class="session-name">pi-hole</div>
            <div class="session-host">pi.local</div>
          </div>
          <div class="session-status">
            <div class="status-dot disconnected"></div>
            <span class="status-label">Disconnected</span>
          </div>
        </div>
      </div>

    </div>

    <!-- Bottom Actions -->
    <div class="sheet-actions">
      <button class="action-btn" id="addSessionBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        新建连接
      </button>
      <button class="action-btn primary" id="splitBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="12" y1="3" x2="12" y2="21"/>
        </svg>
        分屏
      </button>
    </div>

  </div>
</div>

<script>
// ─── State Machine ───
const State = { HIDDEN: 0, REVEALING: 1, REVEALED: 2, HIDING: 3 };
let currentState = State.HIDDEN;

const sheet = document.getElementById('swipeSheet');
const panel = document.getElementById('sheetPanel');
const overlay = document.getElementById('sheetOverlay');
const swipeHint = document.getElementById('swipeHint');
const quickBar = document.getElementById('quickBar');
const swipeProgress = document.getElementById('swipeProgress');
const stateIndicator = document.getElementById('stateIndicator');
const terminalContent = document.getElementById('terminalContent');

// Touch tracking
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let initialPanelX = 0;
let dragging = false;
let revealThreshold = 40; // px
let hideThreshold = 60; // px
let sheetOpen = false;

function showState(label, duration = 1800) {
  stateIndicator.textContent = label;
  stateIndicator.classList.add('visible');
  setTimeout(() => stateIndicator.classList.remove('visible'), duration);
}

// ─── Reveal / Hide ───
function revealSheet() {
  if (sheetOpen) return;
  sheetOpen = true;
  panel.classList.add('revealed');
  overlay.classList.add('revealed');
  panel.style.transition = 'transform 280ms cubic-bezier(0.32,0,0.16,1)';
  panel.style.transform = 'translateX(0)';
  overlay.style.transition = 'opacity 220ms ease';
  overlay.style.opacity = '1';
  swipeHint.classList.remove('visible');
  quickBar.classList.remove('visible');
  showState('Session list');
  // Add fake content to terminal to show it compresses
  updateTerminalForActiveSession();
}

function hideSheet(animated = true) {
  if (!sheetOpen) return;
  sheetOpen = false;
  panel.classList.remove('revealed');
  overlay.classList.remove('revealed');
  panel.style.transition = animated
    ? 'transform 240ms cubic-bezier(0.4,0,0.2,1), opacity 240ms ease'
    : 'none';
  panel.style.transform = 'translateX(100%)';
  overlay.style.transition = 'opacity 200ms ease';
  overlay.style.opacity = '0';
  swipeHint.classList.add('visible');
  quickBar.classList.add('visible');
  showState('← Swipe right');
}

// ─── Touch Events on Stage ───
const stage = document.getElementById('stage');

stage.addEventListener('touchstart', (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchStartTime = Date.now();
  dragging = false;

  // Start tracking swipe from left edge
  if (touchStartX < 80 && !sheetOpen) {
    dragging = true;
    initialPanelX = 0;
    panel.style.transition = 'none';
    panel.style.transform = 'translateX(100%)';
    panel.classList.add('revealed');
    overlay.style.transition = 'none';
    overlay.style.opacity = '0';
    overlay.classList.add('revealed');
    swipeProgress.style.transition = 'none';
    swipeProgress.style.width = '0%';
  }
}, { passive: true });

stage.addEventListener('touchmove', (e) => {
  if (!dragging) return;
  const dx = e.touches[0].clientX - touchStartX;
  const dy = e.touches[0].clientY - touchStartY;

  // Only track horizontal
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dx) < 10) return;

  const progress = Math.min(1, Math.max(0, dx / 280));
  const panelX = 100 - progress * 100;

  panel.style.transform = `translateX(${100 - panelX}%)`;
  overlay.style.opacity = String(progress * 0.45);
  swipeProgress.style.width = String(progress * 100) + '%';
}, { passive: true });

stage.addEventListener('touchend', (e) => {
  if (!dragging) return;
  dragging = false;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const duration = Date.now() - touchStartTime;

  swipeProgress.style.width = '0%';

  if (dx >= revealThreshold || (dx >= 20 && duration < 180)) {
    revealSheet();
  } else {
    hideSheet(true);
  }
}, { passive: true });

// ─── Overlay tap → hide ───
overlay.addEventListener('click', () => hideSheet());
overlay.addEventListener('touchend', (e) => {
  if (e.changedTouches[0].clientX > panel.offsetLeft) return; // only on overlay
  hideSheet();
});

// ─── Session card tap ───
document.querySelectorAll('.session-card').forEach(card => {
  card.addEventListener('click', () => {
    const id = card.dataset.session;
    const isDisconnected = card.style.opacity === '0.5';
    if (isDisconnected) return;

    // Switch active state
    document.querySelectorAll('.session-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');

    // Update quick dots
    const paneClass = card.classList.contains('pane-1') ? 'pane1' : (card.classList.contains('pane-2') ? 'pane2' : '');
    document.querySelectorAll('.quick-dot').forEach(d => {
      d.classList.toggle('active', d.dataset.session === id);
      d.className = 'quick-dot' + (d.classList.contains('active') ? ' ' + paneClass + ' active' : '');
    });

    showState(`Switched: ${card.querySelector('.session-name').textContent}`);
    updateTerminalForActiveSession();
    setTimeout(() => hideSheet(), 220);
  });
});

// ─── Quick dots ───
document.querySelectorAll('.quick-dot').forEach(dot => {
  dot.addEventListener('click', () => {
    const id = dot.dataset.session;
    const card = document.querySelector(`.session-card[data-session="${id}"]`);
    if (!card || card.style.opacity === '0.5') return;

    document.querySelectorAll('.session-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    document.querySelectorAll('.quick-dot').forEach(d => {
      d.classList.remove('active');
      d.className = 'quick-dot';
    });
    dot.classList.add('active');
    updateTerminalForActiveSession();
  });
});

// ─── Pane tabs ───
document.getElementById('paneTab1').addEventListener('click', () => {
  document.getElementById('paneTab1').classList.add('active');
  document.getElementById('paneTab2').classList.remove('active');
  document.getElementById('gridPane2').style.opacity = '0.3';
  document.getElementById('gridPane1').style.opacity = '1';
});
document.getElementById('paneTab2').addEventListener('click', () => {
  document.getElementById('paneTab2').classList.add('active');
  document.getElementById('paneTab1').classList.remove('active');
  document.getElementById('gridPane1').style.opacity = '0.3';
  document.getElementById('gridPane2').style.opacity = '1';
  document.getElementById('sheetContent').scrollTop = document.getElementById('gridPane2').offsetTop - 30;
});

// ─── Close session ───
function closeSession(id) {
  const card = document.querySelector(`.session-card[data-session="${id}"]`);
  if (!card) return;
  card.style.transition = 'opacity 200ms, transform 200ms';
  card.style.opacity = '0';
  card.style.transform = 'scale(0.92)';
  setTimeout(() => card.remove(), 220);
}

// ─── Fake terminal update ───
const fakeTerminals = {
  s1: [
    'fanzhang@macstudio ~ % ls ~/code/zterm',
    'android  mac  packages  scripts  vendor',
    'fanzhang@macstudio ~ % ',
  ],
  s2: [
    '[android] $ adb devices',
    'List of devices attached',
    ' emulator-5554 device',
    '[android] $ ',
  ],
  s3: [
    'root@server-prod:~# tail -f /var/log/syslog',
    'Jun 21 18:50:01 CRON[1234]: session opened',
    'Jun 21 18:50:15 nginx: 10.0.0.5 - GET /api/health 200',
    'root@server-prod:~# ',
  ],
};

function updateTerminalForActiveSession() {
  const activeCard = document.querySelector('.session-card.active');
  const id = activeCard?.dataset.session || 's1';
  const lines = fakeTerminals[id] || fakeTerminals.s1;
  const prompt = lines[lines.length - 1] || '';
  terminalContent.innerHTML = lines.slice(0, -1).map(l =>
    `<div style="margin-bottom:2px">${l}</div>`
  ).join('') + `<div class="prompt-line">${prompt}<span class="prompt-cursor"></span></div>`;
}

// ─── Add session button ───
document.getElementById('addSessionBtn').addEventListener('click', () => {
  showState('→ New connection sheet');
});

// ─── Split button ───
document.getElementById('splitBtn').addEventListener('click', () => {
  showState('→ Split mode');
  document.getElementById('paneTab2').classList.remove('active');
  document.getElementById('paneTab1').classList.add('active');
  document.getElementById('gridPane2').style.opacity = '1';
  document.getElementById('gridPane1').style.opacity = '1';
});

// ─── Initial state ───
quickBar.classList.add('visible');
showState('← Swipe right', 2500);

// Animate hint pulse
let hintPulse = 0;
function pulseHint() {
  hintPulse++;
  const op = 0.5 + 0.5 * Math.sin(hintPulse * 0.04);
  swipeHint.style.opacity = String(0.5 + op * 0.5);
  requestAnimationFrame(pulseHint);
}
pulseHint();
</script>

</body>
</html>
