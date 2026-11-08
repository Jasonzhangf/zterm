import { createBootstrapDaemonApi } from "./daemon-client.mjs";
import { createBootstrapApp, bootstrapRouteUrl, parseBootstrapRoute } from "./bootstrap-app.mjs";

function field(root, name) {
  return root.querySelector(`[data-field="${name}"]`)?.value ?? "";
}

export function mountBootstrapApp(root) {
  if (!root) {
    return null;
  }
  const daemonApi = createBootstrapDaemonApi({ baseUrl: "" });
  const app = createBootstrapApp({ daemonApi, initialHash: globalThis.location?.hash ?? "" });

  function render() {
    root.innerHTML = app.render();
  }

  async function handleAction(action, button) {
    switch (action) {
      case "navigate": {
        const route = button.getAttribute("data-route") || "setup";
        app.navigate(route);
        if (globalThis.location && globalThis.location.hash !== bootstrapRouteUrl(route)) {
          globalThis.location.hash = bootstrapRouteUrl(route);
        }
        render();
        break;
      }
      case "save-endpoint": {
        const form = button.closest("form");
        try {
          app.setDaemonEndpoint(field(form, "daemon-endpoint"));
        } catch (error) {
          app.state.endpointError = { code: error.code, message: error.message };
        }
        render();
        break;
      }
      case "login": {
        const form = button.closest("form");
        const authenticated = await app.login({
          loginName: field(form, "login-name"),
          credential: field(form, "credential"),
        });
        if (authenticated) {
          if (globalThis.location) {
            globalThis.location.hash = bootstrapRouteUrl("workspaces");
          }
          app.navigate("workspaces");
        }
        render();
        break;
      }
      case "logout": {
        const result = await app.logout();
        if (result.ok && globalThis.location) {
          globalThis.location.hash = bootstrapRouteUrl("login");
        }
        if (result.ok) {
          app.navigate("login");
        }
        render();
        break;
      }
      case "load-workspaces": {
        await app.loadWorkspaces();
        render();
        break;
      }
      case "select-workspace": {
        const workspaceId = button.getAttribute("data-workspace-id");
        await app.selectWorkspace(workspaceId);
        render();
        break;
      }
      case "enroll-machine": {
        if (button.disabled) {
          break;
        }
        app.state.machineEnrollment = {
          enabled: false,
          reason: {
            code: "MACHINE_ENROLLMENT_UNAVAILABLE",
            message: "Machine enrollment is not exposed by the daemon control plane yet.",
          },
        };
        render();
        break;
      }
      default:
        break;
    }
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-action]");
    if (!button) {
      return;
    }
    const form = button.closest("form");
    if (form) {
      event.preventDefault();
    }
    void handleAction(button.getAttribute("data-action"), button);
  });

  if (globalThis.location) {
    globalThis.addEventListener("hashchange", () => {
      app.navigate(parseBootstrapRoute(globalThis.location.hash, app.state.route));
      render();
    });
  }

  render();
  void app.restoreSession().then(() => {
    if (
      globalThis.location &&
      app.state.route === "workspaces" &&
      globalThis.location.hash !== bootstrapRouteUrl("workspaces")
    ) {
      globalThis.location.hash = bootstrapRouteUrl("workspaces");
    }
    render();
  });
  return app;
}

if (typeof document !== "undefined") {
  mountBootstrapApp(document.querySelector("#bootstrap-root"));
}
