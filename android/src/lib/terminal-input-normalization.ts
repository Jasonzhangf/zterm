export function normalizeTerminalCommittedText(input: string) {
  if (!input) {
    return '';
  }

  let output = '';
  for (const char of input) {
    const code = char.codePointAt(0) || 0;
    if (code === 0x3000) {
      output += ' ';
      continue;
    }
    if (code >= 0xff01 && code <= 0xff5e) {
      output += String.fromCodePoint(code - 0xfee0);
      continue;
    }
    output += char;
  }
  return output;
}
