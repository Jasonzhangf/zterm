import { WasmBridge } from '@jsonstudio/wtermmod-core';
import type { TerminalCell, TerminalCursorState } from '@zterm/shared/types';

export interface HerdrTerminalFrame {
  type: 'terminal.frame';
  bytes: string;
  seq: number;
  full: boolean;
  width: number;
  height: number;
  scroll?: HerdrScrollMetrics;
}

export interface HerdrScrollMetrics {
  maxOffsetFromBottom: number;
  offsetFromBottom: number;
  viewportRows: number;
}

export interface HerdrAbsoluteRange {
  startIndex: number;
  endIndex: number;
  availableStartIndex: number;
  availableEndIndex: number;
  origin: 'herdr-canonicalizer-scrollback';
}

export interface HerdrCanonicalSnapshot {
  ztermRevision: number;
  attachmentSeq: number;
  full: boolean;
  cols: number;
  rows: number;
  bufferLines: TerminalCell[][];
  cursor: TerminalCursorState | null;
  localCursor: { row: number; col: number; visible: boolean } | null;
  cursorKeysApp: boolean;
  alternateScreen: boolean;
  scrollbackCount: number;
  absoluteRange: HerdrAbsoluteRange | null;
  capabilityGaps: readonly string[];
}

function validateFrame(frame: HerdrTerminalFrame) {
  if (frame.type !== 'terminal.frame') {
    throw new Error('invalid Herdr terminal.frame type');
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 1) {
    throw new Error('invalid Herdr terminal.frame seq');
  }
  if (!Number.isInteger(frame.width) || frame.width < 1) {
    throw new Error('invalid Herdr terminal.frame width');
  }
  if (!Number.isInteger(frame.height) || frame.height < 1) {
    throw new Error('invalid Herdr terminal.frame height');
  }
  if (typeof frame.bytes !== 'string' || frame.bytes.length === 0) {
    throw new Error('invalid Herdr terminal.frame bytes');
  }
  const decoded = Buffer.from(frame.bytes, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== frame.bytes.replace(/=+$/u, (padding) => padding)) {
    throw new Error('invalid Herdr terminal.frame base64 bytes');
  }
}

function projectCells(bridge: WasmBridge): TerminalCell[][] {
  return Array.from({ length: bridge.getRows() }, (_, row) => (
    Array.from({ length: bridge.getCols() }, (_, col) => bridge.getCell(row, col))
  ));
}

function projectCanonicalLines(bridge: WasmBridge): TerminalCell[][] {
  const scrollbackCount = bridge.getScrollbackCount();
  const lines = Array.from({ length: scrollbackCount }, (_, row) => (
    Array.from({ length: bridge.getCols() }, (_, col) => bridge.getScrollbackCell(row, col))
  ));
  return lines.concat(projectCells(bridge));
}

function validateScrollMetrics(metrics: HerdrScrollMetrics, frame: HerdrTerminalFrame) {
  if (!Number.isInteger(metrics.maxOffsetFromBottom) || metrics.maxOffsetFromBottom < 0) {
    throw new Error('invalid Herdr max_offset_from_bottom');
  }
  if (!Number.isInteger(metrics.offsetFromBottom) || metrics.offsetFromBottom < 0) {
    throw new Error('invalid Herdr offset_from_bottom');
  }
  if (metrics.offsetFromBottom > metrics.maxOffsetFromBottom) {
    throw new Error('Herdr offset_from_bottom exceeds max_offset_from_bottom');
  }
  if (metrics.viewportRows !== frame.height) {
    throw new Error(
      `Herdr scroll viewport rows ${metrics.viewportRows} do not match frame height ${frame.height}`,
    );
  }
}

export class HerdrFrameCanonicalizer {
  private bridge: WasmBridge | null = null;
  private lastAttachmentSeq: number | null = null;
  private attachmentCols = 0;
  private attachmentRows = 0;
  private ztermRevision = 0;

  static async create() {
    const canonicalizer = new HerdrFrameCanonicalizer();
    canonicalizer.bridge = await WasmBridge.load();
    return canonicalizer;
  }

  resetAttachment() {
    this.lastAttachmentSeq = null;
    this.attachmentCols = 0;
    this.attachmentRows = 0;
  }

  getRevision() {
    return this.ztermRevision;
  }

  apply(frame: HerdrTerminalFrame): HerdrCanonicalSnapshot {
    validateFrame(frame);
    if (!this.bridge) {
      throw new Error('Herdr canonicalizer is not initialized');
    }

    const geometryChanged = this.attachmentCols !== frame.width || this.attachmentRows !== frame.height;
    if (this.lastAttachmentSeq === null) {
      if (!frame.full) {
        throw new Error('Herdr first terminal.frame must be full');
      }
    } else if (frame.seq !== this.lastAttachmentSeq + 1) {
      throw new Error(
        `Herdr frame cannot advance attachment seq=${this.lastAttachmentSeq} to seq=${frame.seq}`,
      );
    } else if (geometryChanged && !frame.full) {
      throw new Error('Herdr geometry change requires a full attachment frame');
    }

    const scrollMetrics = frame.scroll;
    if (scrollMetrics) {
      validateScrollMetrics(scrollMetrics, frame);
    }

    if (frame.full || geometryChanged || this.lastAttachmentSeq === null) {
      this.bridge.init(frame.width, frame.height);
      this.attachmentCols = frame.width;
      this.attachmentRows = frame.height;
    }

    this.bridge.writeRaw(Buffer.from(frame.bytes, 'base64'));
    this.lastAttachmentSeq = frame.seq;
    this.ztermRevision += 1;

    const localCursor = this.bridge.getCursor();
    const scrollbackCount = this.bridge.getScrollbackCount();
    const totalLines = scrollbackCount + this.bridge.getRows();
    const absoluteRange: HerdrAbsoluteRange = {
      startIndex: 0,
      endIndex: totalLines,
      availableStartIndex: 0,
      availableEndIndex: totalLines,
      origin: 'herdr-canonicalizer-scrollback',
    };
    const absoluteCursor: TerminalCursorState | null = scrollMetrics?.offsetFromBottom === 0
      ? {
        rowIndex: scrollbackCount + localCursor.row,
        col: localCursor.col,
        visible: localCursor.visible,
      }
      : null;
    const capabilityGaps: readonly string[] = scrollMetrics && scrollMetrics.offsetFromBottom !== 0
      ? ['absolute-cursor-unavailable-while-host-scrolled']
      : [];

    return {
      ztermRevision: this.ztermRevision,
      attachmentSeq: frame.seq,
      full: frame.full,
      cols: this.bridge.getCols(),
      rows: this.bridge.getRows(),
      bufferLines: projectCanonicalLines(this.bridge),
      cursor: absoluteCursor,
      localCursor,
      cursorKeysApp: this.bridge.cursorKeysApp(),
      alternateScreen: this.bridge.usingAltScreen(),
      scrollbackCount,
      absoluteRange,
      capabilityGaps,
    };
  }
}
