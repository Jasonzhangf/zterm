// Platform-agnostic session interface
export interface Session {
  id: string;
  title: string;
  columns: Column[];
  activePaneId?: string;
}

export interface Column {
  id: string;
  panes: Pane[];
  width: number; // 0-100 percentage
}

export interface Pane {
  id: string;
  type: "terminal" | "editor" | "viewer";
  content?: string;
  active: boolean;
  splitDirection?: "horizontal" | "vertical";
  children?: Pane[];
}

export interface LayoutProfile {
  minWidth: number;
  maxWidth: number;
  columnCount: number;
  defaultSplit: "horizontal" | "vertical";
}

export interface TerminalMessage {
  type: "data" | "resize" | "title" | "exit";
  sessionId: string;
  payload: any;
}

export type PlatformAdapter = {
  platform: "android" | "mac" | "win";
  version: string;
  getNativeBridge: () => any;
  onTerminalOutput: (callback: (msg: TerminalMessage) => void) => void;
  sendInput: (sessionId: string, data: string) => void;
};
