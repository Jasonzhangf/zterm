export function decodeKeySequence(input: string): string {
  let output = '';

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (char === '\\' && index + 1 < input.length) {
      const next = input[index + 1];

      if (next === 'n') {
        output += '\n';
        index += 1;
        continue;
      }
      if (next === 'r') {
        output += '\r';
        index += 1;
        continue;
      }
      if (next === 't') {
        output += '\t';
        index += 1;
        continue;
      }
      if (next === 'e') {
        output += '\x1b';
        index += 1;
        continue;
      }
      if (next === 'x' && index + 3 < input.length) {
        const hex = input.slice(index + 2, index + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          output += String.fromCharCode(parseInt(hex, 16));
          index += 3;
          continue;
        }
      }
      if (next === 'u' && index + 5 < input.length) {
        const hex = input.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          output += String.fromCharCode(parseInt(hex, 16));
          index += 5;
          continue;
        }
      }
      output += next;
      index += 1;
      continue;
    }

    if (char === '^' && index + 1 < input.length) {
      const next = input[index + 1];
      if (next === '?') {
        output += '\x7f';
        index += 1;
        continue;
      }

      const upper = next.toUpperCase();
      if (upper >= 'A' && upper <= '_') {
        output += String.fromCharCode(upper.charCodeAt(0) - 64);
        index += 1;
        continue;
      }
    }

    output += char;
  }

  return output;
}

export function encodeKeySequence(sequence: string): string {
  let output = '';

  for (const char of sequence) {
    const code = char.charCodeAt(0);

    if (char === '\n') {
      output += '\\n';
    } else if (char === '\r') {
      output += '\\r';
    } else if (char === '\t') {
      output += '\\t';
    } else if (code === 0x1b) {
      output += '\\x1b';
    } else if (code === 0x7f) {
      output += '^?';
    } else if (code < 0x20) {
      output += `^${String.fromCharCode(code + 64)}`;
    } else {
      output += char;
    }
  }

  return output;
}
