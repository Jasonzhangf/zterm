/**
 * shared Mac terminal view surface.
 *
 * Mac 用 wtermmod-react Terminal 组件包装成 @zterm/shared 可直接导入的 React 组件。
 * Props 映射到 @jsonstudio/wtermmod-react Terminal interface。
 *
 * 平台扩展 props：
 * - sessionId / projection / active / allowDomFocus / themeId / showAbsoluteLineNumbers:
 *   来自 Mac native render path 旧 contract；本切片先全部接受并合理转发/忽略，
 *   语义真实工作属于后续切片（mac-3 wtermmod native render 接入）。
 * - onInput / onResize: 转发到 wtermmod onData / onResize。
 * - onViewportChange / onImagePaste: 接 noop 占位，wtermmod 暂不直接对应。
 *
 * 不在 shared 持有任何 session/buffer/connection 状态，只负责渲染 + 透传事件。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Terminal } from '@jsonstudio/wtermmod-react';
import type { TerminalHandle, TerminalProps as WTermTerminalProps } from '@jsonstudio/wtermmod-react';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';

export type { WTermTerminalProps as TerminalProps };

export interface MacTerminalViewProps {
  sessionId?: string | null;
  projection?: TerminalRenderBufferProjection;
  active?: boolean;
  allowDomFocus?: boolean;
  themeId?: string;
  showAbsoluteLineNumbers?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onViewportChange?: (viewState: unknown) => void;
  onImagePaste?: (file: File) => Promise<void> | void;
  onWidthModeChange?: (mode: string, cols?: number | null) => void;
}

function cellToString(cell: TerminalCell) {
  if (cell.width === 0) return '';
  return cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
}

function projectionToTerminalText(projection: TerminalRenderBufferProjection | undefined) {
  if (!projection || projection.lines.length === 0) return '';
  return projection.lines
    .map((line) => line.map(cellToString).join('').replace(/\s+$/u, ''))
    .join('\r\n');
}

export function MacTerminalView(props: MacTerminalViewProps) {
  const {
    projection,
    active = false,
    allowDomFocus = false,
    themeId,
    showAbsoluteLineNumbers: _showAbsoluteLineNumbers = false,
    onInput,
    onResize,
    onViewportChange: _onViewportChange,
    onImagePaste: _onImagePaste,
    onWidthModeChange: _onWidthModeChange,
  } = props;

  const terminalRef = useRef<TerminalHandle | null>(null);
  const pendingTextRef = useRef<string>('');
  const lastRevisionRef = useRef<number | null>(null);
  const cols = projection?.cols ?? 80;
  const rows = projection?.rows ?? 24;
  const terminalText = useMemo(() => projectionToTerminalText(projection), [projection]);
  void active;
  void allowDomFocus;

  const writeProjection = useCallback((text: string) => {
    if (!text) return;
    pendingTextRef.current = text;
    if (!terminalRef.current) return;
    terminalRef.current.write(`\x1b[H\x1b[2J${text}`);
    pendingTextRef.current = '';
  }, []);

  useEffect(() => {
    if (!projection || projection.revision === lastRevisionRef.current) return;
    lastRevisionRef.current = projection.revision;
    writeProjection(terminalText);
  }, [projection, terminalText, writeProjection]);

  return (
    <Terminal
      ref={terminalRef}
      cols={cols}
      rows={rows}
      autoResize
      theme={themeId === 'dark' ? 'dark' : undefined}
      onData={(data: string) => onInput?.(data)}
      onResize={onResize}
      onReady={() => {
        if (pendingTextRef.current) {
          terminalRef.current?.write(`\x1b[H\x1b[2J${pendingTextRef.current}`);
          pendingTextRef.current = '';
        }
      }}
    />
  );
}

// Compatibility alias so existing Mac imports still resolve
export function TerminalView(props: WTermTerminalProps) {
  return <Terminal {...props} />;
}
