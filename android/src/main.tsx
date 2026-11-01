import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installInputModalityRuntime } from './components/ambient/input-modality-runtime';
import { writeTextToClipboard } from './pages/terminal-copy-selection';
import './index.css';

installInputModalityRuntime();

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await writeTextToClipboard(text);
    return true;
  } catch {
    // fall through to the textarea fallback
  }
  let field: HTMLTextAreaElement | null = null;
  try {
    field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', 'true');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field?.parentNode?.removeChild(field);
  }
}

function formatErrorDetail(error: Error, componentStack: string | null, capturedAt: string): string {
  const head = error?.stack || `${error?.name || 'Error'}: ${error?.message || String(error)}`;
  const parts = [`[zterm:react-error] ${capturedAt}`, head];
  if (componentStack) {
    parts.push('--- componentStack ---', componentStack);
  }
  return parts.join('\n');
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; info: string | null; capturedAt: string; copied: boolean }
> {
  state = {
    error: null as Error | null,
    info: null as string | null,
    capturedAt: '',
    copied: false,
  };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // eslint-disable-next-line no-console
    console.error('[zterm:react-error]', error?.message, error?.stack, info?.componentStack);
    this.setState({ error, info: info?.componentStack ?? null, capturedAt: new Date().toISOString() });
  }
  handleCopy = async () => {
    if (!this.state.error) return;
    const detail = formatErrorDetail(this.state.error, this.state.info, this.state.capturedAt);
    const copied = await copyTextToClipboard(detail);
    this.setState({ copied });
  };
  render() {
    const { error, info, capturedAt, copied } = this.state;
    if (error) {
      const summary = `${error.name || 'Error'}: ${error.message || String(error)}`;
      const detail = formatErrorDetail(error, info, capturedAt);
      return React.createElement(
        'main',
        {
          style: {
            position: 'fixed',
            inset: 0,
            padding: '16px',
            margin: 0,
            display: 'grid',
            placeItems: 'center',
            backgroundColor: '#16191f',
            color: '#f5f7fb',
          },
        },
        React.createElement(
          'section',
          { style: { width: 'min(100%, 480px)', display: 'grid', gap: '12px' } },
          React.createElement('h1', { style: { margin: 0, fontSize: '20px' } }, '页面加载失败'),
          React.createElement(
            'p',
            { style: { margin: 0, lineHeight: 1.5, color: '#9b9da5' } },
            '请复制下面的错误详情反馈，或重新加载应用。',
          ),
          React.createElement(
            'div',
            {
              'data-testid': 'root-error-detail',
              style: {
                margin: 0,
                padding: '10px',
                maxHeight: '40vh',
                overflow: 'auto',
                background: '#0d1014',
                border: '1px solid #262b33',
                borderRadius: '8px',
                color: '#d7dbe2',
                fontFamily: 'monospace',
                fontSize: '12px',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            },
            React.createElement('strong', null, summary),
            React.createElement('br'),
            React.createElement('br'),
            detail,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: this.handleCopy,
              style: { minHeight: '44px', border: '1px solid #38d47d', borderRadius: '8px', background: 'transparent', color: '#38d47d', fontWeight: 700 },
            },
            copied ? '已复制' : '复制错误详情',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => window.location.reload(),
              style: { minHeight: '44px', border: 0, borderRadius: '8px', background: '#38d47d', color: '#07110b', fontWeight: 700 },
            },
            '重新加载',
          ),
        ),
      );
    }
    return this.props.children;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    // eslint-disable-next-line no-console
    console.log('[zterm:window-error]', event.message, event.filename, event.lineno, event.colno, event.error?.stack);
  });
  window.addEventListener('unhandledrejection', (event) => {
    // eslint-disable-next-line no-console
    console.log('[zterm:unhandledrejection]', event.reason?.message ?? event.reason, event.reason?.stack);
  });

  // Bridge console.* to Android Logcat via JavaScriptInterface
  (function() {
    var _methods: (keyof Console)[] = ['log', 'warn', 'error', 'info', 'debug'];
    var consoleSlots = console as unknown as Record<string, (...args: unknown[]) => void>;
    _methods.forEach(function(method) {
      var orig = consoleSlots[method].bind(console);
      consoleSlots[method] = function() {
        var args = Array.prototype.slice.call(arguments);
        var tag = args.shift() || method;
        var msg = args.map(function(a) {
          if (a === null) return 'null';
          if (a === undefined) return 'undefined';
          if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch(e) { return String(a); }
          }
          return String(a);
        }).join(' ');
        var ztermLog = (window as Window & { ZTermLog?: { log: (tag: string, msg: string) => void } }).ZTermLog;
        if (ztermLog && ztermLog.log) {
          ztermLog.log(tag, msg);
        }
        orig.apply(console, Array.prototype.slice.call(arguments));
      };
    });
  })();

  // eslint-disable-next-line no-console
  console.log('[zterm:boot]', 'main.tsx loaded', 'window.innerWidth=', window.innerWidth);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
