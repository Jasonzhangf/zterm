import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@jsonstudio/wtermmod-react";
import { createTerminalSelection } from "./selection.mjs";

export function TerminalApp({ api }) {
  const [phase, setPhase] = useState("checking");
  const [token, setToken] = useState("");
  const [sessions, setSessions] = useState([]);
  const [activeTarget, setActiveTarget] = useState(null);
  const [status, setStatus] = useState("Connecting");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const [command, setCommand] = useState("");
  const loadedRef = useRef(false);

  const terminalRef = useRef(null);
  const admissionRef = useRef(null);
  const readyRef = useRef(false);
  const pendingRef = useRef("");

  const selection = useMemo(() => createTerminalSelection({
    resolveAdmission: (target) => api.resolveTerminalAdmission(target),
    openStream: (admission, handlers) => api.openTerminalStream(admission, handlers),
  }), [api]);

  const closeStream = useCallback(() => {
    selection.close();
    admissionRef.current = null;
    pendingRef.current = "";
  }, [selection]);

  const flushPending = useCallback(() => {
    if (readyRef.current && pendingRef.current) {
      terminalRef.current?.write(pendingRef.current);
      pendingRef.current = "";
    }
  }, []);

  const selectTarget = useCallback(async (session) => {
    const target = typeof session === "string" ? { name: session } : (session || {});
    setError("");
    setStatus("Connecting");
    const result = await selection.select(target, {
      onAdmission: (admission) => {
        setActiveTarget(target.name || "");
        admissionRef.current = admission;
      },
      onReady: () => {
        setStatus("Live");
      },
      onBuffer: (payload) => {
        const frame = payload.frame;
        if (frame && Number.isFinite(frame.cols) && Number.isFinite(frame.rows)) {
          setCols(frame.cols);
          setRows(frame.rows);
          try {
            terminalRef.current?.resize(frame.cols, frame.rows);
          } catch {
            // The renderer may not be ready yet; the next render syncs size.
          }
        }
        const ansi = typeof payload.ansi === "string" ? payload.ansi : "";
        if (readyRef.current) {
          terminalRef.current?.write(ansi);
        } else {
          pendingRef.current += ansi;
        }
        setStatus("Live");
        setError("");
      },
      onError: (streamError) => {
        setStatus("Unavailable");
        setError(`${streamError.code}: ${streamError.message}`);
      },
    });

    if (!result) {
      return;
    }
    if (!result.admission) {
      setStatus("Unavailable");
      if (result.error) {
        setError(`${result.error.code || "ERROR"}: ${result.error.message}`);
      } else {
        setError("TERMINAL_ADMISSION_UNRESOLVED: no authorized member binding for this session.");
      }
      return;
    }
  }, [selection]);

  const loadSessions = useCallback(async () => {
    setStatus("Connecting");
    try {
      const payload = await api.listSessions();
      const next = Array.isArray(payload.sessions) ? payload.sessions : [];
      setSessions(next);
      setPhase("ready");
      setStatus("Connected");
      if (!loadedRef.current) {
        loadedRef.current = true;
        const requested = new URLSearchParams(window.location.search).get("target");
        const initial = (requested ? next.find((session) => session.name === requested) : null) || next[0] || null;
        if (initial) {
          selectTarget(initial);
        }
      }
    } catch (requestError) {
      if (requestError.status === 401) {
        setPhase("login");
        setStatus("Signed out");
        return;
      }
      setPhase("ready");
      setStatus("Unavailable");
      setError(`${requestError.code || "ERROR"}: ${requestError.message}`);
    }
  }, [api, selectTarget]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await api.sessionState();
        if (cancelled) {
          return;
        }
        if (state.authenticated && api.hasAuthorization?.()) {
          await loadSessions();
        } else if (state.authenticated) {
          setPhase("login");
          setStatus("Signed out");
          setError("SESSION_AUTHORIZATION_RESTORE_REQUIRED: sign in again to restore terminal authorization.");
        } else {
          setPhase("login");
          setStatus("Signed out");
        }
      } catch (stateError) {
        if (!cancelled) {
          setPhase("login");
          setStatus("Signed out");
          setError(stateError.message || "Authentication state is unavailable.");
        }
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [api, loadSessions, closeStream]);

  const handleLogin = async (event) => {
    event.preventDefault();
    if (!token.trim()) {
      return;
    }
    setSubmitting(true);
    setError("");
    loadedRef.current = false;
    try {
      await api.login(token.trim());
      setToken("");
      await loadSessions();
    } catch (loginError) {
      setError(`${loginError.code || "ERROR"}: ${loginError.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    closeStream();
    await api.logout().catch(() => {});
    loadedRef.current = false;
    setSessions([]);
    setActiveTarget(null);
    setPhase("login");
    setStatus("Signed out");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!activeTarget || !command || !admissionRef.current) {
      return;
    }
    try {
      setError("");
      await api.sendInput(admissionRef.current, command);
      setCommand("");
    } catch (inputError) {
      setError(`${inputError.code || "ERROR"}: ${inputError.message}`);
    }
  };

  const handleReady = () => {
    readyRef.current = true;
    flushPending();
  };

  if (phase === "login") {
    return (
      <div className="gate">
        <form className="gate-card" onSubmit={handleLogin}>
          <h1>Zterm V2</h1>
          <p className="gate-copy">Sign in to list and attach terminal sessions on this host.</p>
          <label htmlFor="access-token">Access token</label>
          <input
            id="access-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit" disabled={submitting || !token.trim()}>
            {submitting ? "Signing in" : "Sign in"}
          </button>
          {error ? <p className="gate-error" role="alert">{error}</p> : null}
        </form>
      </div>
    );
  }

  const activeSession = sessions.find((session) => session.name === activeTarget) || null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><strong>Zterm V2</strong><span>Remote tmux</span></div>
        <div className="topbar-actions">
          <span className={`health health-${status.toLowerCase()}`} aria-live="polite">{status}</span>
          <button type="button" className="ghost-button" onClick={handleLogout}>Sign out</button>
        </div>
      </header>
      <main className="workspace">
        <aside className="sidebar" aria-label="Sessions">
          <div className="sidebar-head"><h2>Sessions</h2></div>
          <ul className="session-list" aria-live="polite">
            {sessions.length === 0 ? (
              <li className="empty">No tmux sessions found.</li>
            ) : sessions.map((session) => (
              <li key={session.id || session.name}>
                <button
                  type="button"
                  className="session-button"
                  data-target={session.name}
                  aria-pressed={session.name === activeTarget}
                  onClick={() => selectTarget(session)}
                >
                  <span className="session-name">{session.name}</span>
                  <span className="session-id">{session.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="terminal-shell" aria-label="Terminal">
          <div className="terminal-head">
            <div className="terminal-title-wrap">
              <div className="terminal-title" id="terminal-title">{activeTarget || "No session selected"}</div>
              {activeSession ? <div className="terminal-meta">{activeSession.id}</div> : null}
            </div>
          </div>
          {error ? <p className="message" role="alert">{error}</p> : null}
          <div className="terminal-surface" id="terminal-surface">
            <Terminal
              ref={terminalRef}
              cols={cols}
              rows={rows}
              autoResize={false}
              cursorBlink
              onReady={handleReady}
              onError={(renderError) => setError(`RENDERER_FAILED: ${renderError && renderError.message ? renderError.message : renderError}`)}
            />
          </div>
          <form className="input-bar" onSubmit={handleSubmit}>
            <label htmlFor="command-input" className="visually-hidden">Command</label>
            <input
              id="command-input"
              autoComplete="off"
              spellCheck={false}
              placeholder="Command"
              value={command}
              disabled={!activeTarget}
              onChange={(event) => setCommand(event.target.value)}
            />
            <button id="send-button" type="submit" disabled={!activeTarget || !command}>Send</button>
          </form>
        </section>
      </main>
    </div>
  );
}
