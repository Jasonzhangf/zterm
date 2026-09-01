import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; info: string | null }
> {
  state = { error: null as Error | null, info: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // eslint-disable-next-line no-console
    console.error('[zterm:react-error]', error?.message, error?.stack, info?.componentStack);
    this.setState({ error, info: info?.componentStack ?? null });
  }
  render() {
    if (this.state.error) {
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
            backgroundColor: '#0b1220',
            color: '#f5f7fb',
          },
        },
        React.createElement(
          'section',
          { style: { width: 'min(100%, 420px)', display: 'grid', gap: '12px' } },
          React.createElement('h1', { style: { margin: 0, fontSize: '20px' } }, '页面加载失败'),
          React.createElement('p', { style: { margin: 0, lineHeight: 1.5, color: '#c7d0df' } }, '请重新加载应用。错误详情已记录。'),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => window.location.reload(),
              style: { minHeight: '44px', border: 0, borderRadius: '8px', background: '#8bd5ff', color: '#0b1220', fontWeight: 700 },
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
