import { mobileTheme } from '../../lib/mobile-ui';

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
  if (safe >= 1024 * 1024) {
    return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (safe >= 1024) {
    return `${(safe / 1024).toFixed(1)} KB`;
  }
  return `${safe} B`;
}

function resolveStatusCopy(state: RemoteScreenshotPreviewState) {
  switch (state.phase) {
    case 'request-sent':
      return {
        title: '截图请求已发送',
        detail: '等待远端开始处理截图请求…',
      };
    case 'capturing':
      return {
        title: '远端正在截图',
        detail: '等待远端截屏完成…',
      };
    case 'transferring':
      return {
        title: '远端正在传图',
        detail: state.totalChunks
          ? `已接收 ${Math.max(0, state.receivedChunks || 0)}/${state.totalChunks} 块 · ${formatBytes(state.totalBytes)}`
          : '截图已完成，正在传输…',
      };
    case 'transfer-complete':
      return {
        title: '传图完成',
        detail: '截图数据已接收，正在准备预览…',
      };
    case 'saving':
      return {
        title: '正在保存截图',
        detail: `写入 Download/zterm/${state.fileName}`,
      };
    case 'failed':
      return {
        title: '截图失败',
        detail: state.errorMessage || '远端截图失败',
      };
    case 'preview-ready':
    default:
      return {
        title: '截图预览',
        detail: `请确认是否保存：${state.fileName}`,
      };
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
      { key: 'sent', label: '发送成功', status: 'done' },
      { key: 'captured', label: '截图成功', status: 'error' },
      { key: 'transferred', label: '传送成功', status: 'pending' },
      { key: 'displayed', label: '显示', status: 'pending' },
    ] as const;
  }

  return [
    { key: 'sent', label: '发送成功', status: currentRank > 1 ? 'done' : currentRank === 1 ? 'active' : 'pending' },
    { key: 'captured', label: '截图成功', status: currentRank > 2 ? 'done' : currentRank === 2 ? 'active' : 'pending' },
    { key: 'transferred', label: '传送成功', status: currentRank > 3 ? 'done' : currentRank === 3 || currentRank === 3.5 ? 'active' : 'pending' },
    { key: 'displayed', label: '显示', status: currentRank >= 4 ? 'done' : currentRank === 3.5 ? 'active' : 'pending' },
  ] as const;
}

export function RemoteScreenshotSheet({
  state,
  onSave,
  onDiscard,
}: RemoteScreenshotSheetProps) {
  if (!state) {
    return null;
  }

  const copy = resolveStatusCopy(state);
  const busy = state.phase !== 'preview-ready' && state.phase !== 'failed';
  const steps = resolveStepStates(state.phase);

  return (
    <div
      data-testid="remote-screenshot-sheet"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 112,
        background: 'rgba(5, 8, 14, 0.86)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'stretch',
      }}
    >
      <div
        style={{
          width: '100%',
          maxHeight: '84vh',
          borderTopLeftRadius: '22px',
          borderTopRightRadius: '22px',
          border: `1px solid ${mobileTheme.colors.cardBorder}`,
          background: mobileTheme.colors.shell,
          boxShadow: '0 -16px 40px rgba(0,0,0,0.32)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px 10px' }}>
          <div style={{ color: '#fff', fontSize: '17px', fontWeight: 800 }}>{copy.title}</div>
          <div style={{ marginTop: '4px', color: mobileTheme.colors.textSecondary, fontSize: '13px' }}>
            {copy.detail}
          </div>
          <div
            style={{
              marginTop: '12px',
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: '8px',
            }}
          >
            {steps.map((step) => (
              <div
                key={step.key}
                data-testid={`remote-screenshot-step-${step.key}`}
                data-step-status={step.status}
                style={{
                  borderRadius: '12px',
                  border: step.status === 'done'
                    ? '1px solid rgba(31,214,122,0.28)'
                    : step.status === 'error'
                      ? '1px solid rgba(255,107,107,0.30)'
                    : step.status === 'active'
                      ? '1px solid rgba(141,183,255,0.36)'
                      : '1px solid rgba(255,255,255,0.08)',
                  background: step.status === 'done'
                    ? 'rgba(31,214,122,0.10)'
                    : step.status === 'error'
                      ? 'rgba(255,107,107,0.12)'
                    : step.status === 'active'
                      ? 'rgba(141,183,255,0.10)'
                      : 'rgba(255,255,255,0.03)',
                  padding: '8px 6px',
                }}
              >
                <div
                  style={{
                    color: step.status === 'done'
                      ? mobileTheme.colors.accent
                      : step.status === 'error'
                        ? '#ff9b9b'
                      : step.status === 'active'
                        ? '#8db7ff'
                        : mobileTheme.colors.textSecondary,
                    fontSize: '11px',
                    fontWeight: 800,
                    textAlign: 'center',
                  }}
                >
                  {step.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            padding: '0 12px 12px',
          }}
        >
          <div
            style={{
              minHeight: '220px',
              maxHeight: '56vh',
              borderRadius: '18px',
              border: '1px solid rgba(255,255,255,0.08)',
              background: '#0e1320',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {state.previewDataUrl ? (
              <img
                data-testid="remote-screenshot-preview-image"
                src={state.previewDataUrl}
                alt={state.fileName}
                style={{
                  maxWidth: '100%',
                  maxHeight: '56vh',
                  objectFit: 'contain',
                  display: 'block',
                }}
              />
            ) : state.phase === 'failed' ? (
              <div
                data-testid="remote-screenshot-error"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '10px',
                  color: '#ffd4d4',
                  fontSize: '14px',
                  padding: '0 20px',
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '999px',
                    background: 'rgba(255,107,107,0.18)',
                    color: '#ff9b9b',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: '18px',
                    fontWeight: 800,
                  }}
                >
                  !
                </div>
                <div>{copy.detail}</div>
              </div>
            ) : (
              <div
                data-testid="remote-screenshot-progress"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#dce7ff',
                  fontSize: '14px',
                }}
              >
                <div
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '999px',
                    border: '3px solid rgba(141, 183, 255, 0.22)',
                    borderTopColor: '#8db7ff',
                    animation: 'zterm-remote-shot-spin 0.9s linear infinite',
                  }}
                />
                <div>{copy.detail}</div>
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '10px',
            padding: '0 12px calc(14px + env(safe-area-inset-bottom, 0px))',
          }}
        >
          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            style={{
              flex: 1,
              minHeight: '44px',
              borderRadius: '14px',
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'rgba(31, 38, 53, 0.82)',
              color: '#fff',
              fontWeight: 700,
              opacity: busy ? 0.45 : 1,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            {state.phase === 'failed' ? '关闭' : '丢弃'}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={state.phase !== 'preview-ready'}
            style={{
              flex: 1,
              minHeight: '44px',
              borderRadius: '14px',
              border: '1px solid rgba(31,214,122,0.18)',
              background: 'rgba(31,214,122,0.18)',
              color: mobileTheme.colors.accent,
              fontWeight: 800,
              opacity: state.phase === 'preview-ready' ? 1 : 0.45,
              cursor: state.phase === 'preview-ready' ? 'pointer' : 'not-allowed',
            }}
          >
            保存到下载
          </button>
        </div>
      </div>

      <style>
        {`@keyframes zterm-remote-shot-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
    </div>
  );
}
