import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRect,
  RemoteWindowStreamRequestPayload,
} from '@zterm/shared/protocol';

export const REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS = 220;

export function remoteWindowError(
  payload: RemoteWindowStreamRequestPayload,
  code: string,
  message: string,
): RemoteWindowStreamErrorPayload {
  return {
    requestId: payload.requestId || '',
    code,
    message,
  };
}

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateRemoteWindowErrorMessage(message: string) {
  const normalized = normalizeWhitespace(message);
  if (normalized.length <= REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS - 1).trimEnd()}...`;
}

export function isExecFileTimeoutError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    killed?: boolean;
    signal?: string | null;
    code?: string | number | null;
    message?: string;
  };
  return candidate.killed === true
    || candidate.signal === 'SIGTERM'
    || candidate.code === 'ETIMEDOUT'
    || /timed out|timeout/iu.test(candidate.message || '');
}

export function formatInlineScriptExecFailure(
  error: Error,
  stdout: string,
  stderr: string,
  timeoutMs: number,
  timeoutMessage: string,
  fallbackMessage: string,
) {
  const timeoutDetail = isExecFileTimeoutError(error)
    ? `${timeoutMessage} after ${timeoutMs}ms`
    : '';
  return [stderr, stdout, timeoutDetail, error.message && !error.message.includes(' -c ') && !error.message.includes(' -e ') ? error.message : '']
    .filter(Boolean)
    .join('\n') || fallbackMessage;
}

export function buildScreenCaptureKitStartupTimeoutMessage(stderrBuffer: string, timeoutMs: number) {
  const stderrDetail = stderrBuffer
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  return stderrDetail
    ? `ScreenCaptureKit capture did not produce a frame before timeout after ${timeoutMs}ms: ${stderrDetail}`
    : `ScreenCaptureKit capture did not produce a frame before timeout after ${timeoutMs}ms`;
}

export function summarizeRemoteWindowCatalogError(error: unknown, fallbackMessage: string) {
  const raw = error instanceof Error ? error.message : String(error);
  const normalizedRaw = normalizeWhitespace(raw);
  const missingPythonModule = normalizedRaw.match(/No module named ['"]?([A-Za-z0-9_.-]+)['"]?/u);
  if (missingPythonModule?.[1]) {
    return `iTerm2 Python API unavailable: missing Python module ${missingPythonModule[1]}`;
  }

  const candidateLines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('Command failed:'));
  const diagnosticLine = [...candidateLines].reverse().find((line) =>
    /(?:error|exception|denied|permission|timeout|timed out|not found|unavailable|failed)/iu.test(line),
  ) || candidateLines[0] || normalizedRaw || fallbackMessage;
  return truncateRemoteWindowErrorMessage(diagnosticLine || fallbackMessage);
}

export function validateRect(rect: RemoteWindowStreamRect, label: string): RemoteWindowStreamRect {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = rect[key];
    if (!Number.isFinite(value)) {
      throw new Error(`${label}.${key} must be finite`);
    }
  }
  if (rect.width < 0 || rect.height < 0) {
    throw new Error(`${label} dimensions must be non-negative`);
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export function rectWithOffset(rect: RemoteWindowStreamRect, offset: { x: number; y: number }): RemoteWindowStreamRect {
  return {
    x: offset.x + rect.x,
    y: offset.y + rect.y,
    width: rect.width,
    height: rect.height,
  };
}
