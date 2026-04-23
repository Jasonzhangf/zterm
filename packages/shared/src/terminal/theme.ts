export type TerminalThemeId =
  | 'classic-dark'
  | 'tabby-relaxed'
  | 'iterm2-light'
  | 'gruvbox-dark'
  | 'catppuccin-mocha';

export interface TerminalThemePreset {
  id: TerminalThemeId;
  name: string;
  family: 'Built-in' | 'Tabby-inspired' | 'iTerm2-inspired' | 'Community classic';
  description: string;
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent?: string;
  selection?: string;
  selectionForeground?: string;
  colors: readonly [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string,
  ];
}

const TERMINAL_THEME_PRESET_LIST: TerminalThemePreset[] = [
  {
    id: 'classic-dark',
    name: 'Classic Dark',
    family: 'Built-in',
    description: '当前默认深色映射，偏 VS / xterm 风格。',
    foreground: '#d4d4d4',
    background: '#000000',
    cursor: '#f5f5f5',
    cursorAccent: '#000000',
    selection: 'rgba(255,255,255,0.18)',
    colors: [
      '#1e1e1e', '#f44747', '#6a9955', '#d7ba7d',
      '#569cd6', '#c586c0', '#4ec9b0', '#d4d4d4',
      '#808080', '#f44747', '#6a9955', '#d7ba7d',
      '#569cd6', '#c586c0', '#4ec9b0', '#ffffff',
    ],
  },
  {
    id: 'tabby-relaxed',
    name: 'Tabby Relaxed',
    family: 'Tabby-inspired',
    description: '参考 Tabby 终端常见的柔和深色系。',
    foreground: '#d9d9d9',
    background: '#1f2330',
    cursor: '#e4e7ef',
    cursorAccent: '#1f2330',
    selection: 'rgba(172, 242, 237, 0.18)',
    colors: [
      '#151a21', '#bc5653', '#909d63', '#ebc17a',
      '#6a8799', '#b06698', '#c9dfff', '#d9d9d9',
      '#636363', '#bc5653', '#a0ac77', '#ebc17a',
      '#7eaac7', '#b06698', '#acf2ed', '#f7f7f7',
    ],
  },
  {
    id: 'iterm2-light',
    name: 'iTerm2 Light Background',
    family: 'iTerm2-inspired',
    description: '参考 iTerm2 的浅色 preset 方向，适合白底阅读。',
    foreground: '#222222',
    background: '#ffffff',
    cursor: '#222222',
    cursorAccent: '#ffffff',
    selection: 'rgba(2, 37, 199, 0.14)',
    colors: [
      '#000000', '#c91b00', '#00c200', '#c7c400',
      '#0225c7', '#ca30c7', '#00c5c7', '#c7c7c7',
      '#686868', '#ff6e67', '#5ffa68', '#fffc67',
      '#6871ff', '#ff77ff', '#60fdff', '#ffffff',
    ],
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    family: 'Community classic',
    description: '经典暖色系终端配色，强调对比和低刺眼。',
    foreground: '#ebdbb2',
    background: '#282828',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selection: 'rgba(146, 131, 116, 0.24)',
    colors: [
      '#282828', '#cc241d', '#98971a', '#d79921',
      '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f',
      '#83a598', '#d3869b', '#8ec07c', '#fbf1c7',
    ],
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    family: 'Community classic',
    description: '低噪声紫灰深色调，适合长时间盯屏。',
    foreground: '#cdd6f4',
    background: '#1e1e2e',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selection: 'rgba(137, 180, 250, 0.18)',
    colors: [
      '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af',
      '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af',
      '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8',
    ],
  },
];

const TERMINAL_THEME_PRESETS = Object.freeze(
  Object.fromEntries(
    TERMINAL_THEME_PRESET_LIST.map((preset) => [preset.id, Object.freeze(preset)]),
  ) as Record<TerminalThemeId, Readonly<TerminalThemePreset>>,
);

export const DEFAULT_TERMINAL_THEME_ID: TerminalThemeId = 'classic-dark';
export const TERMINAL_THEME_OPTIONS = TERMINAL_THEME_PRESET_LIST.map((preset) => TERMINAL_THEME_PRESETS[preset.id]);

export function isTerminalThemeId(input: unknown): input is TerminalThemeId {
  return typeof input === 'string' && input in TERMINAL_THEME_PRESETS;
}

export function normalizeTerminalThemeId(input: unknown): TerminalThemeId {
  return isTerminalThemeId(input) ? input : DEFAULT_TERMINAL_THEME_ID;
}

export function getTerminalThemePreset(input?: string | null): Readonly<TerminalThemePreset> {
  return TERMINAL_THEME_PRESETS[normalizeTerminalThemeId(input)];
}
