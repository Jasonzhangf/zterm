export interface TerminalShortcutToken {
  label: string;
  sequence: string;
  kind?: 'modifier' | 'key' | 'text';
}

export interface BuiltTerminalShortcutSequence {
  sequence: string;
  preview: string;
  error: string;
}

export function encodeCtrlShortcutKey(letter: string) {
  const upper = letter.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code < 65 || code > 90) {
    return '';
  }
  return String.fromCharCode(code - 64);
}

export function isTerminalShortcutModifierToken(token: TerminalShortcutToken) {
  return token.kind === 'modifier';
}

export function formatTerminalShortcutKeyLabel(token: TerminalShortcutToken) {
  if (token.sequence.length === 1 && /^[a-z]$/i.test(token.sequence)) {
    return token.label.length === 1 ? token.label.toUpperCase() : token.label;
  }
  return token.label;
}

export function buildTerminalShortcutSequence(tokens: TerminalShortcutToken[]): BuiltTerminalShortcutSequence {
  if (tokens.length === 0) {
    return {
      sequence: '',
      preview: '',
      error: '',
    };
  }

  const modifiers = tokens.filter(isTerminalShortcutModifierToken).map((token) => token.label);
  const normalTokens = tokens.filter((token) => !isTerminalShortcutModifierToken(token));

  if (modifiers.length === 0) {
    return {
      sequence: normalTokens.map((token) => token.sequence).join(''),
      preview: normalTokens.map((token) => token.label).join(' + '),
      error: '',
    };
  }

  if (normalTokens.length !== 1) {
    return {
      sequence: '',
      preview: tokens.map((token) => token.label).join(' + '),
      error: '带修饰键时当前只支持一个目标按键',
    };
  }

  const keyToken = normalTokens[0];
  const hasCtrl = modifiers.includes('Ctrl');
  const hasShift = modifiers.includes('Shift');
  const hasCommand = modifiers.includes('Command');
  const hasOption = modifiers.includes('Option');

  if (hasOption) {
    return {
      sequence: '',
      preview: tokens.map((token) => token.label).join(' + '),
      error: 'Option 组合暂未接入终端编码',
    };
  }

  if (hasCommand && (keyToken.label === 'Cmd+V' || keyToken.label === 'Paste')) {
    return {
      sequence: '\x16',
      preview: 'Command + V',
      error: '',
    };
  }

  if (hasCommand && (keyToken.sequence === 'v' || keyToken.sequence === 'V')) {
    return {
      sequence: '\x16',
      preview: `Command + ${keyToken.label}`,
      error: '',
    };
  }

  if (hasCtrl) {
    if (keyToken.sequence.length === 1) {
      const encoded = encodeCtrlShortcutKey(keyToken.sequence);
      if (!encoded) {
        return {
          sequence: '',
          preview: tokens.map((token) => token.label).join(' + '),
          error: 'Ctrl 当前只支持字母键',
        };
      }
      return {
        sequence: encoded,
        preview: `Ctrl + ${formatTerminalShortcutKeyLabel(keyToken)}`,
        error: '',
      };
    }

    return {
      sequence: '',
      preview: tokens.map((token) => token.label).join(' + '),
      error: 'Ctrl 当前只支持字母键',
    };
  }

  if (hasShift) {
    if (keyToken.label === 'Tab') {
      return {
        sequence: '\x1b[Z',
        preview: 'Shift + Tab',
        error: '',
      };
    }
    if (keyToken.label === 'Return' || keyToken.label === 'Enter') {
      return {
        sequence: '\n',
        preview: 'Shift + Enter',
        error: '',
      };
    }
    if (keyToken.sequence.length === 1) {
      return {
        sequence: keyToken.sequence.toUpperCase(),
        preview: `Shift + ${formatTerminalShortcutKeyLabel(keyToken)}`,
        error: '',
      };
    }

    return {
      sequence: '',
      preview: tokens.map((token) => token.label).join(' + '),
      error: 'Shift 当前只支持字母/Enter/Tab',
    };
  }

  return {
    sequence: keyToken.sequence,
    preview: tokens.map((token) => token.label).join(' + '),
    error: '',
  };
}

export function decodeCtrlShortcutTokens(sequence: string): TerminalShortcutToken[] | null {
  if (sequence.length !== 1) {
    return null;
  }

  const code = sequence.charCodeAt(0);
  if (code < 1 || code > 26) {
    return null;
  }

  const letter = String.fromCharCode(code + 64);
  return [
    { label: 'Ctrl', sequence: '__CTRL__', kind: 'modifier' },
    { label: letter, sequence: letter.toLowerCase(), kind: 'text' },
  ];
}

export function buildTerminalShortcutTokensFromSequence(
  label: string,
  sequence: string,
  presets: Array<Pick<TerminalShortcutToken, 'label' | 'sequence'>> = [],
): TerminalShortcutToken[] {
  const ctrlTokens = decodeCtrlShortcutTokens(sequence);
  if (ctrlTokens) {
    return ctrlTokens;
  }

  const matchedPreset = presets.find((preset) => preset.sequence === sequence)
    || (sequence.length === 1 && label.startsWith('Ctrl+') ? { label, sequence } : null);

  if (matchedPreset) {
    return [{ label: matchedPreset.label, sequence: matchedPreset.sequence }];
  }

  return sequence
    ? [{ label: label || '已有序列', sequence }]
    : [];
}

export function resolveTerminalShortcutLabel(manualLabel: string, preview: string, fallback = '新按键') {
  return manualLabel.trim() || preview || fallback;
}
