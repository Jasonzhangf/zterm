export function extractApkSmokePrintableAsciiLines(buffer: Buffer) {
  const lines: string[] = [];
  let current = '';
  let binaryGap = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
    current = '';
    binaryGap = 0;
  };

  for (const byte of buffer.values()) {
    if (byte === 10 || byte === 13) {
      flush();
      continue;
    }
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      binaryGap = 0;
      continue;
    }
    if (!current) {
      continue;
    }
    binaryGap += 1;
    if (binaryGap >= 2) {
      flush();
    }
  }

  flush();
  return lines;
}

