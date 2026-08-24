import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const IS_DEV = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

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
      // Production: keep the painted app surface; never replace it with a red
      // error pre. The error is already logged to logcat via the console bridge
      // and will surface through normal app recovery flows.
      if (!IS_DEV) {
        return (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: '#0b1220',
              color: 'transparent',
            }}
            aria-hidden="true"
          />
        );
      }
      return React.createElement(
        'pre',
        {
          style: {
            position: 'fixed',
            inset: 0,
            padding: '16px',
            margin: 0,
            backgroundColor: '#fff5f5',
            color: '#7f1d1d',
            fontSize: '12px',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            fontFamily: 'monospace',
          },
        },
        `[zterm:render-error] ${this.state.error.message}\n\n${this.state.error.stack ?? ''}\n\n${this.state.info ?? ''}`,
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
