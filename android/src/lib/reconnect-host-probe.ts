/**
 * Lightweight reachability probe for a host candidate. We do NOT attempt the
 * full mux handshake here - the goal is just to confirm the host:port answers
 * within `timeoutMs` so the reconnect path can decide whether to switch to a
 * fallback endpoint.
 *
 * Default protocol is http: the daemon exposes GET /health, so a no-cors
 * fetch avoids opening a short-lived WebSocket (a real WS connect would be a
 * duplicate handshake against the same host:port that the subsequent real
 * connection is about to perform). On Android WebView, `fetch` with
 * `mode: 'no-cors'` against http/https works for reachability without
 * triggering CORS errors. For ws:// we cannot use fetch; we use a raw
 * WebSocket connect with a short timeout.
 */
export type ProbeProtocol = 'ws' | 'http';

export type ProbeResult =
  | { reachable: true; elapsedMs: number }
  | { reachable: false; reason: 'timeout' | 'error'; elapsedMs: number };

export async function probeHostReachable(
  bridgeHost: string,
  bridgePort: number,
  options: {
    protocol?: ProbeProtocol;
    timeoutMs?: number;
  } = {},
): Promise<ProbeResult> {
  const protocol = options.protocol || 'http';
  const timeoutMs = Math.max(250, Math.floor(options.timeoutMs ?? 1500));
  const started = Date.now();
  const url = protocol === 'http'
    ? `http://${bridgeHost}:${bridgePort}/health`
    : `ws://${bridgeHost}:${bridgePort}/`;

  return new Promise<ProbeResult>((resolve) => {
    const done = (result: ProbeResult) => {
      clearTimeout(timer);
      try {
        // Best-effort cleanup so a still-pending fetch/WS does not keep the
        // runtime alive once we move on to the next candidate.
        if (typeof abortController !== 'undefined' && abortController) {
          try { abortController.abort(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({ reachable: false, reason: 'timeout', elapsedMs: Date.now() - started });
    }, timeoutMs);

    let abortController: AbortController | undefined;
    try {
      if (protocol === 'http') {
        abortController = new AbortController();
        fetch(url, { method: 'GET', mode: 'no-cors', signal: abortController.signal })
          .then(() => done({ reachable: true, elapsedMs: Date.now() - started }))
          .catch(() => done({ reachable: false, reason: 'error', elapsedMs: Date.now() - started }));
        return;
      }
      const ws = new WebSocket(url);
      ws.onopen = () => {
        try { ws.close(); } catch { /* ignore */ }
        done({ reachable: true, elapsedMs: Date.now() - started });
      };
      ws.onerror = () => {
        done({ reachable: false, reason: 'error', elapsedMs: Date.now() - started });
      };
    } catch (err) {
      done({ reachable: false, reason: 'error', elapsedMs: Date.now() - started });
    }
  });
}
