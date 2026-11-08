import { esc } from "./setup.mjs";

export function renderLoginPage(state = {}) {
  const session = state.session || { authenticated: false, configured: false };
  const authError = state.authError;
  return `
    <section class="bootstrap-page" data-page="login" aria-labelledby="login-title">
      <header class="page-head">
        <div>
          <h1 id="login-title">Login</h1>
          <p class="page-sub">Authenticate with the daemon account session. The credential is never stored by this page.</p>
        </div>
        <span class="badge ${session.authenticated ? "badge-ok" : "badge-muted"}" data-role="session-badge">
          ${session.authenticated ? "Authenticated" : "Not authenticated"}
        </span>
      </header>

      <form id="login-form" class="panel" data-role="login-form" novalidate>
        <label class="field">
          <span>Login name</span>
          <input name="loginName" data-field="login-name" autocomplete="username">
        </label>
        <label class="field">
          <span>Credential</span>
          <input name="credential" data-field="credential" type="password" autocomplete="current-password">
        </label>
        ${authError ? `<p class="alert" role="alert" data-role="login-error">${esc(authError.code)}: ${esc(authError.message)}</p>` : ""}
        ${state.logoutError ? `<p class="alert" role="alert" data-role="logout-error">${esc(state.logoutError.code)}: ${esc(state.logoutError.message)}</p>` : ""}
        <div class="actions">
          <button type="submit" data-action="login" ${state.loginPending ? "disabled" : ""}>Log in</button>
          <button type="button" data-action="logout" data-testid="logout-button" ${state.logoutPending ? "disabled" : ""}>Log out</button>
        </div>
      </form>

      <nav class="page-nav" aria-label="Bootstrap pages">
        <button type="button" data-action="navigate" data-route="setup">Setup</button>
        <button type="button" data-action="navigate" data-route="workspaces">Workspaces</button>
      </nav>
    </section>
  `;
}
