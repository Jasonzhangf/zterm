import React from "react";
import { createRoot } from "react-dom/client";
import "@jsonstudio/wtermmod-react/css";
import "./app.css";
import { createDaemonApi } from "../../clients/daemon-api/index.mjs";
import { TerminalApp } from "../../clients/terminal-client/index.jsx";

createRoot(document.querySelector("#app")).render(
  React.createElement(TerminalApp, { api: createDaemonApi({ baseUrl: "" }) }),
);
