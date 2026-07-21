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

const SHIFT_ARROW_SHORTCUT_SEQUENCES: Record<string, string> = {
  '\x1b[A': '\x1b[1;2A',
  '\x1b[B': '\x1b[1;2B',
  '\x1b[C': '\x1b[1;2C',
  '\x1b[D': '\x1b[1;2D',
};

const SHIFT_ARROW_SHORTCUT_TOKENS: Record<string, Pick<TerminalShortcutToken, 'label' | 'sequence' | 'kind'>> = {
  '\x1b[1;2A': { label: '↑', sequence: '\x1b[A', kind: 'key' },
  '\x1b[1;2B': { label: '↓', sequence: '\x1b[B', kind: 'key' },
  '\x1b[1;2C': { label: '→', sequence: '\x1b[C', kind: 'key' },
  '\x1b[1;2D': { label: '←', sequence: '\x1b[D', kind: 'key' },
};

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

function formatTerminalShortcutPreview(modifiers: string[], keyToken: TerminalShortcutToken) {
  const orderedModifiers = ['Ctrl', 'Option', 'Command', 'Shift']
    .filter((modifier) => modifiers.includes(modifier));
  return [...orderedModifiers, formatTerminalShortcutKeyLabel(keyToken)].join(' + ');
}

function resolveShiftModifiedShortcutSequence(keyToken: TerminalShortcutToken) {
  if (keyToken.sequence === '\t' || keyToken.label === 'Tab') {
    return '\x1b[Z';
  }
  if (keyToken.sequence === '\r' || keyToken.label === 'Return' || keyToken.label === 'Enter') {
    return '\n';
  }
  const shiftedArrowSequence = SHIFT_ARROW_SHORTCUT_SEQUENCES[keyToken.sequence];
  if (shiftedArrowSequence) {
    return shiftedArrowSequence;
  }
  if (keyToken.sequence.length === 1 && /^[a-z]$/i.test(keyToken.sequence)) {
    return keyToken.sequence.toUpperCase();
  }
  return '';
}

function resolveModifiedShortcutSequence(
  modifiers: string[],
  keyToken: TerminalShortcutToken,
): BuiltTerminalShortcutSequence {
  const hasCtrl = modifiers.includes('Ctrl');
  const hasShift = modifiers.includes('Shift');
  const hasCommand = modifiers.includes('Command');
  const hasOption = modifiers.includes('Option');
  const preview = formatTerminalShortcutPreview(modifiers, keyToken);

  if (hasOption) {
    return {
      sequence: '',
      preview,
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
      preview,
      error: '',
    };
  }

  if (hasCtrl) {
    if (keyToken.sequence.length === 1) {
      const encoded = encodeCtrlShortcutKey(keyToken.sequence);
      if (!encoded) {
        return {
          sequence: '',
          preview,
          error: 'Ctrl 当前只支持字母键',
        };
      }
      return {
        sequence: encoded,
        preview,
        error: '',
      };
    }

    return {
      sequence: '',
      preview,
      error: 'Ctrl 当前只支持字母键',
    };
  }

  if (hasShift) {
    const shiftedSequence = resolveShiftModifiedShortcutSequence(keyToken);
    if (shiftedSequence) {
      return {
        sequence: shiftedSequence,
        preview,
        error: '',
      };
    }
    return {
      sequence: '',
      preview,
      error: 'Shift 当前只支持字母/Enter/Tab/方向键',
    };
  }

  return {
    sequence: keyToken.sequence,
    preview: keyToken.label,
    error: '',
  };
}

export function buildTerminalShortcutSequence(tokens: TerminalShortcutToken[]): BuiltTerminalShortcutSequence {
  if (tokens.length === 0) {
    return {
      sequence: '',
      preview: '',
      error: '',
    };
  }

  const sequenceParts: string[] = [];
  const previewParts: string[] = [];
  let pendingModifiers: string[] = [];

  for (const token of tokens) {
    if (isTerminalShortcutModifierToken(token)) {
      if (!pendingModifiers.includes(token.label)) {
        pendingModifiers = [...pendingModifiers, token.label];
      }
      continue;
    }

    if (pendingModifiers.length > 0) {
      const built = resolveModifiedShortcutSequence(pendingModifiers, token);
      if (built.error || !built.sequence) {
        return built;
      }
      sequenceParts.push(built.sequence);
      previewParts.push(built.preview);
      pendingModifiers = [];
      continue;
    }

    sequenceParts.push(token.sequence);
    previewParts.push(token.label);
  }

  if (pendingModifiers.length > 0) {
    return {
      sequence: '',
      preview: pendingModifiers.join(' + '),
      error: '修饰键后需要选择一个目标按键',
    };
  }

  return {
    sequence: sequenceParts.join(''),
    preview: previewParts.join(' + '),
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
  presets: Array<Pick<TerminalShortcutToken, 'label' | 'sequence' | 'kind'>> = [],
): TerminalShortcutToken[] {
  const matchedPreset = presets.find((preset) => preset.sequence === sequence)
    || (sequence.length === 1 && label.startsWith('Ctrl+') ? { label, sequence } : null);

  if (matchedPreset) {
    return [{ label: matchedPreset.label, sequence: matchedPreset.sequence, kind: matchedPreset.kind }];
  }

  if (sequence in SHIFT_ARROW_SHORTCUT_TOKENS) {
    const shiftedToken = SHIFT_ARROW_SHORTCUT_TOKENS[sequence];
    return [
      { label: 'Shift', sequence: '__SHIFT__', kind: 'modifier' },
      shiftedToken,
    ];
  }

  const ctrlTokens = decodeCtrlShortcutTokens(sequence);
  if (ctrlTokens) {
    return ctrlTokens;
  }

  return sequence
    ? [{ label: label || '已有序列', sequence }]
    : [];
}

export function resolveTerminalShortcutLabel(manualLabel: string, preview: string, defaultLabel = '新按键') {
  return manualLabel.trim() || preview || defaultLabel;
}
