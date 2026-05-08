export type ClientDebugSnapshotProducer = () => unknown;

const snapshotSources = new Map<string, ClientDebugSnapshotProducer>();

function readVisualViewport() {
  if (typeof window === 'undefined' || !window.visualViewport) {
    return null;
  }
  return {
    width: Number(window.visualViewport.width || 0),
    height: Number(window.visualViewport.height || 0),
    offsetTop: Number(window.visualViewport.offsetTop || 0),
    offsetLeft: Number(window.visualViewport.offsetLeft || 0),
    scale: Number(window.visualViewport.scale || 1),
  };
}

function readWindowMetrics() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  return {
    innerWidth: Number(window.innerWidth || 0),
    innerHeight: Number(window.innerHeight || 0),
    outerWidth: Number(window.outerWidth || 0),
    outerHeight: Number(window.outerHeight || 0),
    documentClientWidth: Number(document.documentElement?.clientWidth || 0),
    documentClientHeight: Number(document.documentElement?.clientHeight || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
    visualViewport: readVisualViewport(),
  };
}

export function registerClientDebugSnapshotSource(sourceId: string, producer: ClientDebugSnapshotProducer) {
  snapshotSources.set(sourceId, producer);
  return () => {
    const current = snapshotSources.get(sourceId);
    if (current === producer) {
      snapshotSources.delete(sourceId);
    }
  };
}

export function collectClientDebugSnapshot(extra?: Record<string, unknown>) {
  const sources: Record<string, unknown> = {};
  for (const [sourceId, producer] of snapshotSources.entries()) {
    try {
      sources[sourceId] = producer();
    } catch (error) {
      sources[sourceId] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    documentHidden: typeof document === 'undefined' ? null : Boolean(document.hidden),
    online: typeof navigator === 'undefined' ? null : Boolean(navigator.onLine),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    window: readWindowMetrics(),
    sources,
    extra: extra || null,
  };
}
