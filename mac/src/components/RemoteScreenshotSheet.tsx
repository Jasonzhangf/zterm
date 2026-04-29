import { useState, useRef, useCallback, useEffect } from 'react';

export interface RemoteScreenshotPreviewState {
  phase: 'request-sent' | 'capturing' | 'transferring' | 'transfer-complete' | 'preview-ready' | 'saving' | 'failed';
  fileName: string;
  previewDataUrl?: string | null;
  rawDataBase64?: string | null;
  receivedChunks?: number;
  totalChunks?: number;
  totalBytes?: number;
  errorMessage?: string | null;
}

interface RemoteScreenshotSheetProps {
  state: RemoteScreenshotPreviewState | null;
  onSave: () => void;
  onDiscard: () => void;
}

function formatBytes(bytes?: number) {
  const safe = Math.max(0, Math.floor(bytes || 0));
  if (safe >= 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${safe} B`;
}

function resolveStatusCopy(state: RemoteScreenshotPreviewState) {
  switch (state.phase) {
    case 'request-sent':
      return { title: '截图请求已发送', detail: '等待远端开始处理截图请求…' };
    case 'capturing':
      return { title: '远端正在截图', detail: '等待远端截屏完成…' };
    case 'transferring':
      return {
        title: '远端正在传图',
        detail: state.totalChunks
          ? `已接收 ${Math.max(0, state.receivedChunks || 0)}/${state.totalChunks} 块 · ${formatBytes(state.totalBytes)}`
          : '截图已完成，正在传输…',
      };
    case 'transfer-complete':
      return { title: '传图完成', detail: '截图数据已接收，正在准备预览…' };
    case 'saving':
      return { title: '正在保存截图', detail: `写入 Downloads/zterm/${state.fileName}` };
    case 'failed':
      return { title: '截图失败', detail: state.errorMessage || '远端截图失败' };
    case 'preview-ready':
    default:
      return { title: '截图预览', detail: `请确认是否保存：${state.fileName}` };
  }
}

function resolveStepStates(phase: RemoteScreenshotPreviewState['phase']) {
  const currentRank = (() => {
    switch (phase) {
      case 'request-sent': return 1;
      case 'capturing': return 2;
      case 'transferring': return 3;
      case 'transfer-complete': return 3.5;
      case 'failed': return -1;
      case 'preview-ready':
      case 'saving':
      default:
        return 4;
    }
  })();

  if (phase === 'failed') {
    return [
      { key: 'sent', label: '发送成功', status: 'done' as const },
      { key: 'captured', label: '截图成功', status: 'error' as const },
      { key: 'transferred', label: '传送成功', status: 'pending' as const },
      { key: 'displayed', label: '显示', status: 'pending' as const },
    ];
  }

  return [
    { key: 'sent', label: '发送成功', status: currentRank > 1 ? 'done' as const : currentRank === 1 ? 'active' as const : 'pending' as const },
    { key: 'captured', label: '截图成功', status: currentRank > 2 ? 'done' as const : currentRank === 2 ? 'active' as const : 'pending' as const },
    { key: 'transferred', label: '传送成功', status: currentRank > 3 ? 'done' as const : currentRank === 3 || currentRank === 3.5 ? 'active' as const : 'pending' as const },
    { key: 'displayed', label: '显示', status: currentRank >= 4 ? 'done' as const : currentRank === 3.5 ? 'active' as const : 'pending' as const },
  ];
}

export function RemoteScreenshotSheet({ state, onSave, onDiscard }: RemoteScreenshotSheetProps) {
  const [zoomed, setZoomed] = useState(false);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(null);

  useEffect(() => {
    setZoomed(false);
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [state?.previewDataUrl]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((prev) => {
      const next = Math.max(1, Math.min(5, prev * delta));
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale > 1) {
      dragRef.current = { startX: e.clientX, startY: e.clientY, startTx: translate.x, startTy: translate.y };
    }
  }, [scale, translate]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    setTranslate({
      x: dragRef.current.startTx + (e.clientX - dragRef.current.startX),
      y: dragRef.current.startTy + (e.clientY - dragRef.current.startY),
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  if (!state) return null;

  const copy = resolveStatusCopy(state);
  const busy = state.phase !== 'preview-ready' && state.phase !== 'failed';
  const steps = resolveStepStates(state.phase);
  const hasPreview = Boolean(state.previewDataUrl);

  if (zoomed && hasPreview) {
    return (
      <div
        className="screenshot-zoomed-overlay"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={() => {
          if (scale > 1) { setScale(1); setTranslate({ x: 0, y: 0 }); }
          else setScale(2.5);
        }}
      >
        <img
          src={state.previewDataUrl!}
          alt={state.fileName}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
            transition: dragRef.current ? 'none' : 'transform 0.15s ease-out',
            cursor: scale > 1 ? 'grab' : 'zoom-in',
          }}
        />
        <button
          type="button"
          className="screenshot-zoomed-close"
          onClick={() => { setZoomed(false); setScale(1); setTranslate({ x: 0, y: 0 }); }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="screenshot-sheet-backdrop">
      <div className="screenshot-sheet-card" onClick={(e) => e.stopPropagation()}>
        <div className="screenshot-sheet-header">
          <div className="screenshot-sheet-title">{copy.title}</div>
          <div className="screenshot-sheet-detail">{copy.detail}</div>
          <div className="screenshot-steps">
            {steps.map((step) => (
              <div key={step.key} className={`screenshot-step ${step.status}`}>
                {step.label}
              </div>
            ))}
          </div>
        </div>

        <div className="screenshot-preview-area" onClick={() => { if (hasPreview) setZoomed(true); }}>
          {state.previewDataUrl ? (
            <img src={state.previewDataUrl} alt={state.fileName} className="screenshot-preview-img" />
          ) : state.phase === 'failed' ? (
            <div className="screenshot-error-state">
              <div className="screenshot-error-icon">!</div>
              <div>{copy.detail}</div>
            </div>
          ) : (
            <div className="screenshot-loading-state">
              <div className="screenshot-spinner" />
              <div>{copy.detail}</div>
            </div>
          )}
        </div>

        <div className="screenshot-sheet-actions">
          <button type="button" className="screenshot-btn secondary" onClick={onDiscard} disabled={busy}>
            {state.phase === 'failed' ? '关闭' : '丢弃'}
          </button>
          <button type="button" className="screenshot-btn primary" onClick={onSave} disabled={state.phase !== 'preview-ready'}>
            保存到下载
          </button>
        </div>
      </div>
    </div>
  );
}
