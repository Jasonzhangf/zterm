import { copyMenuButtonStyle } from "./terminal-page-shell-ui";
import type { CopySelectionState } from "./terminal-copy-selection";

export interface TerminalPageCopyMenuProps {
 menu: NonNullable<CopySelectionState["menu"]>;
 viewportWidth: number;
 headerTopInsetPx: number;
 startRowIndex: number | null;
 onSetStart: () => void;
 onSetEnd: () => void;
 onCopy: () => void;
 onClose: () => void;
}

export function TerminalPageCopyMenu({
 menu,
 viewportWidth,
 headerTopInsetPx,
 startRowIndex,
 onSetStart,
 onSetEnd,
 onCopy,
 onClose,
}: TerminalPageCopyMenuProps) {
 return (
   <div
     data-testid="terminal-copy-menu"
     className="zterm-copy-menu"
     style={{
       position: "fixed",
       left: `${Math.max(10, Math.min(menu.x - 16, viewportWidth - 236))}px`,
       top: `${Math.max(headerTopInsetPx + 10, menu.y - 58)}px`,
       zIndex: 30,
       display: "flex",
       alignItems: "center",
       gap: "8px",
       padding: "8px",
       borderRadius: "16px",
       border: "1px solid var(--zterm-panel-border)",
       background: "var(--zterm-panel-bg)",
       boxShadow: "0 14px 32px var(--zterm-panel-shadow)",
       backdropFilter: "blur(10px)",
     }}
     onPointerDown={(event) => {
       event.preventDefault();
       event.stopPropagation();
     }}
   >
     <button
       type="button"
       onClick={onSetStart}
       style={copyMenuButtonStyle()}
     >
       设为起点
     </button>
     <button
       type="button"
       disabled={startRowIndex === null}
       onClick={onSetEnd}
       style={copyMenuButtonStyle(startRowIndex === null)}
     >
       设为终点
     </button>
     <button
       type="button"
       disabled={startRowIndex === null}
       onClick={onCopy}
       style={copyMenuButtonStyle(startRowIndex === null)}
     >
       复制
     </button>
     <button
       type="button"
       onClick={onClose}
       style={copyMenuButtonStyle(false, true)}
     >
       关闭
     </button>
   </div>
 );
}
