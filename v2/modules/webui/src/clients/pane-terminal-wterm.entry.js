// Bundle entry for the in-pane wterm renderer. esbuild inlines the released
// @jsonstudio/wtermmod-dom renderer (with its inlined wasm core) and the
// terminal stylesheet into one browser ES module.

import { WTerm } from "@jsonstudio/wtermmod-dom";
import terminalCss from "@jsonstudio/wtermmod-dom/src/terminal.css";

const STYLE_ID = "zterm-v2-pane-wterm-css";

if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = terminalCss;
  document.head.appendChild(style);
}

export { WTerm };
