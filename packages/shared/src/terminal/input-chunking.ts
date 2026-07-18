export const TERMINAL_INPUT_CHUNK_BYTES = 64 * 1024;
export const TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES = 256 * 1024;
export const TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES = 256;
export const TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS = 2;

export function getTerminalInputUtf8ByteLength(input: string) {
  return new TextEncoder().encode(input).byteLength;
}

function getCodePointUtf8ByteLength(codePoint: number) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function splitTerminalInputUtf8Chunks(
  input: string,
  maxChunkBytes = TERMINAL_INPUT_CHUNK_BYTES,
) {
  if (!Number.isFinite(maxChunkBytes) || maxChunkBytes < 4) {
    throw new Error('terminal input chunk size must be at least 4 UTF-8 bytes');
  }
  if (!input) {
    return [] as string[];
  }

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (let index = 0; index < input.length;) {
    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const text = String.fromCodePoint(codePoint);
    const bytes = getCodePointUtf8ByteLength(codePoint);
    if (currentBytes > 0 && currentBytes + bytes > maxChunkBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += text;
    currentBytes += bytes;
    index += text.length;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}
