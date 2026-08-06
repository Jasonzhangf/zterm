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
    console.log('[zterm:react-error]', error?.message, error?.stack, info?.componentStack);
    this.setState({ error, info: info?.componentStack ?? null });
  }
  render() {
    if (this.state.error) {
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
  var _methods = ['log', 'warn', 'error', 'info', 'debug'];
  _methods.forEach(function(method) {
    var orig = console[method].bind(console);
    console[method] = function() {
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
      if (window.ZTermLog && window.ZTermLog.log) {
        window.ZTermLog.log(tag, msg);
      }
      orig.apply(console, arguments);
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
