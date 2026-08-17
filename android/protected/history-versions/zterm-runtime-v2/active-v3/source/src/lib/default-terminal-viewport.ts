const APP_SHELL_MAX_WIDTH_PX = 430;
const DEFAULT_TERMINAL_FONT_SIZE_PX = 5;
const DEFAULT_TERMINAL_LINE_HEIGHT = 1.4;
const DEFAULT_TERMINAL_ROW_HEIGHT_PX = Math.max(
  DEFAULT_TERMINAL_FONT_SIZE_PX + 4,
  Math.ceil(DEFAULT_TERMINAL_FONT_SIZE_PX * 1.5),
);
const ESTIMATED_TERMINAL_HEADER_HEIGHT_PX = 72;
const ESTIMATED_TERMINAL_QUICK_BAR_HEIGHT_PX = 108;
const ESTIMATED_HORIZONTAL_PADDING_PX = 0;
const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 20;
const MAX_TERMINAL_COLS = 180;
const MAX_TERMINAL_ROWS = 120;

function measureTerminalCell() {
  if (typeof document === 'undefined') {
    return {
      cellWidth: Math.max(1, DEFAULT_TERMINAL_FONT_SIZE_PX * 0.62),
      rowHeight: DEFAULT_TERMINAL_ROW_HEIGHT_PX,
    };
  }

  const measureProbeRect = (text: string) => {
    const probe = document.createElement('span');
    probe.textContent = text;
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    probe.style.top = '-9999px';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = [
      '"Sarasa Mono SC"',
      '"Sarasa Term SC"',
      '"Noto Sans Mono CJK SC"',
      '"Noto Sans CJK SC"',
      '"Source Han Sans SC"',
      '"Droid Sans Fallback"',
      '"PingFang SC"',
      '"Microsoft YaHei UI"',
      '"Roboto Mono"',
      '"Menlo"',
      '"Consolas"',
      'monospace',
    ].join(', ');
    probe.style.fontSize = `${DEFAULT_TERMINAL_FONT_SIZE_PX}px`;
    probe.style.lineHeight = String(DEFAULT_TERMINAL_LINE_HEIGHT);
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return rect;
  };

  const latinRect = measureProbeRect('W');
  const cjkRect = measureProbeRect('你');
  const latinWidth = Math.max(1, latinRect.width || DEFAULT_TERMINAL_FONT_SIZE_PX * 0.62);
  const cellWidth = Math.max(latinWidth, (cjkRect.width || latinWidth * 2) / 2);

  return {
    cellWidth,
    rowHeight: Math.max(1, Math.ceil(latinRect.height || DEFAULT_TERMINAL_ROW_HEIGHT_PX), DEFAULT_TERMINAL_ROW_HEIGHT_PX),
  };
}

function getSafeAreaInset(name: string) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return 0;
  }

  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.setProperty(name, `env(${name}, 0px)`);
  document.body.appendChild(probe);
  const computed = window.getComputedStyle(probe).getPropertyValue(name);
  probe.remove();
  const parsed = Number.parseFloat(computed);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getDefaultTerminalViewportSize() {
  if (typeof window === 'undefined') {
    return { cols: 80, rows: 24 };
  }

  const shellWidth = Math.min(window.innerWidth || APP_SHELL_MAX_WIDTH_PX, APP_SHELL_MAX_WIDTH_PX);
  const shellHeight = Math.max(window.innerHeight || 0, 640);
  const safeAreaTop = getSafeAreaInset('padding-top');
  const safeAreaBottom = getSafeAreaInset('padding-bottom');
  const { cellWidth, rowHeight } = measureTerminalCell();

  const usableWidth = Math.max(0, shellWidth - ESTIMATED_HORIZONTAL_PADDING_PX);
  const usableHeight = Math.max(
    0,
    shellHeight
      - ESTIMATED_TERMINAL_HEADER_HEIGHT_PX
      - ESTIMATED_TERMINAL_QUICK_BAR_HEIGHT_PX
      - safeAreaTop
      - safeAreaBottom,
  );

  return {
    cols: Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, Math.floor(usableWidth / cellWidth))),
    rows: Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, Math.floor(usableHeight / rowHeight))),
  };
}
