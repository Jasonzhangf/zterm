export type TerminalThemeId =
  | 'classic-dark'
  | 'tabby-relaxed'
  | 'iterm2-light'
  | 'gruvbox-dark'
  | 'catppuccin-mocha'
  | 'dracula'
  | 'nord'
  | 'one-dark'
  | 'solarized-dark'
  | 'solarized-light'
  | 'tokyo-night-storm'
  | 'monokai'
  | 'ayu-dark'
  | 'night-owl'
  | 'everforest-dark'
  | 'kanagawa-wave'
  | 'rose-pine-moon';

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
  {
    id: 'dracula',
    name: 'Dracula',
    family: 'Community classic',
    description: '高辨识度紫灰底 + 霓虹强调色，经典编辑器/终端主题。',
    foreground: '#f8f8f2',
    background: '#282a36',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selection: 'rgba(68, 71, 90, 0.72)',
    colors: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c',
      '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5',
      '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
    ],
  },
  {
    id: 'nord',
    name: 'Nord',
    family: 'Community classic',
    description: '低饱和冰蓝灰配色，适合长时间低刺激阅读。',
    foreground: '#d8dee9',
    background: '#2e3440',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selection: 'rgba(129, 161, 193, 0.22)',
    colors: [
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b',
      '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b',
      '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
    ],
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    family: 'Community classic',
    description: 'Atom / VS Code 系常见深色方案，颜色分布均衡。',
    foreground: '#abb2bf',
    background: '#282c34',
    cursor: '#abb2bf',
    cursorAccent: '#282c34',
    selection: 'rgba(62, 68, 81, 0.9)',
    colors: [
      '#282c34', '#e06c75', '#98c379', '#e5c07b',
      '#61afef', '#c678dd', '#56b6c2', '#dcdfe4',
      '#5a6374', '#e06c75', '#98c379', '#e5c07b',
      '#61afef', '#c678dd', '#56b6c2', '#ffffff',
    ],
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    family: 'Community classic',
    description: '经典 Solarized 深色版，强调温和对比与语义配色。',
    foreground: '#839496',
    background: '#002b36',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selection: 'rgba(7, 54, 66, 0.9)',
    colors: [
      '#073642', '#dc322f', '#859900', '#b58900',
      '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83',
      '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    family: 'Community classic',
    description: '经典 Solarized 浅色版，适合白底阅读与低对比文本。',
    foreground: '#657b83',
    background: '#fdf6e3',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selection: 'rgba(238, 232, 213, 0.9)',
    colors: [
      '#073642', '#dc322f', '#859900', '#b58900',
      '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83',
      '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
  {
    id: 'tokyo-night-storm',
    name: 'Tokyo Night Storm',
    family: 'Community classic',
    description: '蓝紫夜间配色，层次分明，适合现代终端界面。',
    foreground: '#c0caf5',
    background: '#24283b',
    cursor: '#c0caf5',
    cursorAccent: '#24283b',
    selection: 'rgba(54, 58, 79, 0.95)',
    colors: [
      '#1d202f', '#f7768e', '#9ece6a', '#e0af68',
      '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
      '#414868', '#f7768e', '#9ece6a', '#e0af68',
      '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
    ],
  },
  {
    id: 'monokai',
    name: 'Monokai',
    family: 'Community classic',
    description: '高饱和经典深色主题，代码和终端都很常见。',
    foreground: '#f8f8f2',
    background: '#272822',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selection: 'rgba(73, 72, 62, 0.9)',
    colors: [
      '#272822', '#f92672', '#a6e22e', '#f4bf75',
      '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
      '#75715e', '#f92672', '#a6e22e', '#f4bf75',
      '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5',
    ],
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    family: 'Community classic',
    description: '偏暖色的现代深色方案，兼顾鲜明和耐看。',
    foreground: '#bfbdb6',
    background: '#0a0e14',
    cursor: '#e6b450',
    cursorAccent: '#0a0e14',
    selection: 'rgba(37, 46, 66, 0.95)',
    colors: [
      '#01060e', '#ea6c73', '#91b362', '#f9af4f',
      '#53bdfa', '#fae994', '#90e1c6', '#c7c7c7',
      '#686868', '#f07178', '#c2d94c', '#ffb454',
      '#59c2ff', '#ffee99', '#95e6cb', '#ffffff',
    ],
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    family: 'Community classic',
    description: '偏蓝调的夜间主题，强调清晰对比和长时间阅读。',
    foreground: '#d6deeb',
    background: '#011627',
    cursor: '#80a4c2',
    cursorAccent: '#011627',
    selection: 'rgba(29, 59, 83, 0.95)',
    colors: [
      '#011627', '#ef5350', '#22da6e', '#c5e478',
      '#82aaff', '#c792ea', '#21c7a8', '#ffffff',
      '#575656', '#ef5350', '#22da6e', '#ffeb95',
      '#82aaff', '#c792ea', '#7fdbca', '#ffffff',
    ],
  },
  {
    id: 'everforest-dark',
    name: 'Everforest Dark',
    family: 'Community classic',
    description: '低刺激森林系深色配色，层次温和，适合长时间工作。',
    foreground: '#d3c6aa',
    background: '#2b3339',
    cursor: '#d3c6aa',
    cursorAccent: '#2b3339',
    selection: 'rgba(79, 90, 97, 0.92)',
    colors: [
      '#4b565c', '#e67e80', '#a7c080', '#dbbc7f',
      '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa',
      '#5c6a72', '#f85552', '#8da101', '#dfa000',
      '#3a94c5', '#df69ba', '#35a77c', '#dfddc8',
    ],
  },
  {
    id: 'kanagawa-wave',
    name: 'Kanagawa Wave',
    family: 'Community classic',
    description: '日式低饱和夜色主题，蓝灰底配暖色强调。',
    foreground: '#dcd7ba',
    background: '#1f1f28',
    cursor: '#c8c093',
    cursorAccent: '#1f1f28',
    selection: 'rgba(54, 91, 117, 0.45)',
    colors: [
      '#090618', '#c34043', '#76946a', '#c0a36e',
      '#7e9cd8', '#957fb8', '#6a9589', '#c8c093',
      '#727169', '#e82424', '#98bb6c', '#e6c384',
      '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba',
    ],
  },
  {
    id: 'rose-pine-moon',
    name: 'Rose Pine Moon',
    family: 'Community classic',
    description: '柔和紫褐系深色主题，暗部层次细腻。',
    foreground: '#e0def4',
    background: '#232136',
    cursor: '#e0def4',
    cursorAccent: '#232136',
    selection: 'rgba(57, 53, 82, 0.9)',
    colors: [
      '#393552', '#eb6f92', '#3e8fb0', '#f6c177',
      '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4',
      '#6e6a86', '#eb6f92', '#3e8fb0', '#f6c177',
      '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4',
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
