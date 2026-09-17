export const JUNCTION_PREVIEW_LATTICE_STORAGE_KEY = 'zterm:junction-preview-lattice:v1';

export interface JunctionPreviewTarget {
  sessionId: string;
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}

export interface JunctionPreviewCoordinate {
  col: number;
  row: number;
}

export interface JunctionPreviewLatticeCellV1 extends JunctionPreviewCoordinate {
  target: JunctionPreviewTarget;
}

export interface JunctionPreviewLatticeV1 {
  version: 1;
  cells: JunctionPreviewLatticeCellV1[];
}

interface JunctionPreviewStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function createEmptyJunctionPreviewLattice(): JunctionPreviewLatticeV1 {
  return { version: 1, cells: [] };
}

function isCoordinate(coord: unknown): coord is JunctionPreviewCoordinate {
  if (!coord || typeof coord !== 'object') return false;
  const candidate = coord as Partial<JunctionPreviewCoordinate>;
  return Number.isInteger(candidate.col) && Number.isInteger(candidate.row);
}

export function normalizeJunctionPreviewTarget(value: unknown): JunctionPreviewTarget | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<JunctionPreviewTarget>;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const bridgePort = Number(candidate.bridgePort);
  const sessionName = typeof candidate.sessionName === 'string' ? candidate.sessionName.trim() : '';
  if (!sessionId || !bridgeHost || !Number.isInteger(bridgePort) || bridgePort <= 0 || !sessionName) {
    return null;
  }
  const daemonHostId = typeof candidate.daemonHostId === 'string'
    ? candidate.daemonHostId.trim() || undefined
    : undefined;
  return { sessionId, daemonHostId, bridgeHost, bridgePort, sessionName };
}

export function normalizeJunctionPreviewLattice(value: unknown): JunctionPreviewLatticeV1 | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<JunctionPreviewLatticeV1>;
  if (candidate.version !== 1 || !Array.isArray(candidate.cells)) return null;
  const seenCoordinates = new Set<string>();
  const seenSessionIds = new Set<string>();
  const cells: JunctionPreviewLatticeCellV1[] = [];
  for (const raw of candidate.cells) {
    if (!raw || typeof raw !== 'object') return null;
    const cell = raw as Partial<JunctionPreviewLatticeCellV1>;
    if (typeof cell.col !== 'number' || typeof cell.row !== 'number') return null;
    if (!Number.isInteger(cell.col) || !Number.isInteger(cell.row)) return null;
    const key = `${cell.col}:${cell.row}`;
    if (seenCoordinates.has(key)) return null;
    const target = normalizeJunctionPreviewTarget(cell.target);
    if (!target) return null;
    if (seenSessionIds.has(target.sessionId)) return null;
    seenCoordinates.add(key);
    seenSessionIds.add(target.sessionId);
    cells.push({ col: cell.col, row: cell.row, target });
  }
  return { version: 1, cells };
}

export function getJunctionPreviewCell(
  lattice: JunctionPreviewLatticeV1,
  coordinate: JunctionPreviewCoordinate,
): JunctionPreviewLatticeCellV1 | null {
  return lattice.cells.find((cell) => cell.col === coordinate.col && cell.row === coordinate.row) || null;
}

export function findJunctionPreviewCellBySessionId(
  lattice: JunctionPreviewLatticeV1,
  sessionId: string,
): JunctionPreviewCoordinate | null {
  const cell = lattice.cells.find((candidate) => candidate.target.sessionId === sessionId);
  return cell ? { col: cell.col, row: cell.row } : null;
}

export function findNearestJunctionPreviewCell<T extends {
  id: string;
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}>(
  lattice: JunctionPreviewLatticeV1,
  focus: JunctionPreviewCoordinate,
  openSessions: readonly T[],
): JunctionPreviewCoordinate | null {
  let nearest: { coordinate: JunctionPreviewCoordinate; distance: number } | null = null;
  for (const cell of lattice.cells) {
    if (!resolveJunctionPreviewCell(lattice, cell, openSessions)) continue;
    const distance = Math.abs(cell.col - focus.col) + Math.abs(cell.row - focus.row);
    if (!nearest || distance < nearest.distance) {
      nearest = { coordinate: { col: cell.col, row: cell.row }, distance };
    }
  }
  return nearest?.coordinate || null;
}

export function setJunctionPreviewCell(
  lattice: JunctionPreviewLatticeV1,
  coordinate: JunctionPreviewCoordinate,
  rawTarget: JunctionPreviewTarget,
): { ok: true; lattice: JunctionPreviewLatticeV1 } | {
  ok: false;
  reason: 'invalid-coordinate' | 'invalid-target' | 'session-already-assigned';
  lattice: JunctionPreviewLatticeV1;
} {
  if (!isCoordinate(coordinate) || typeof coordinate.col !== 'number' || typeof coordinate.row !== 'number') {
    return { ok: false, reason: 'invalid-coordinate', lattice };
  }
  const target = normalizeJunctionPreviewTarget(rawTarget);
  if (!target) return { ok: false, reason: 'invalid-target', lattice };
  const previousTargetCoordinate = lattice.cells.find(
    (cell) => cell.target.sessionId === target.sessionId
      && (cell.col !== coordinate.col || cell.row !== coordinate.row),
  );
  if (previousTargetCoordinate) {
    return { ok: false, reason: 'session-already-assigned', lattice };
  }
  const existingIndex = lattice.cells.findIndex(
    (cell) => cell.col === coordinate.col && cell.row === coordinate.row,
  );
  if (existingIndex >= 0) {
    const cells = lattice.cells.slice();
    cells[existingIndex] = { col: coordinate.col, row: coordinate.row, target };
    return { ok: true, lattice: { version: 1, cells } };
  }
  return {
    ok: true,
    lattice: { version: 1, cells: [...lattice.cells, { col: coordinate.col, row: coordinate.row, target }] },
  };
}

export function clearJunctionPreviewCell(
  lattice: JunctionPreviewLatticeV1,
  coordinate: JunctionPreviewCoordinate,
): JunctionPreviewLatticeV1 {
  return {
    version: 1,
    cells: lattice.cells.filter((cell) => cell.col !== coordinate.col || cell.row !== coordinate.row),
  };
}

export function moveJunctionPreviewFocus(
  focus: JunctionPreviewCoordinate,
  direction: 'left' | 'right' | 'up' | 'down',
): JunctionPreviewCoordinate {
  switch (direction) {
    case 'left':
      return { col: focus.col - 1, row: focus.row };
    case 'right':
      return { col: focus.col + 1, row: focus.row };
    case 'up':
      return { col: focus.col, row: focus.row - 1 };
    case 'down':
      return { col: focus.col, row: focus.row + 1 };
  }
}

export function resolveJunctionPreviewCell<T extends {
  id: string;
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}>(
  lattice: JunctionPreviewLatticeV1,
  coordinate: JunctionPreviewCoordinate,
  openSessions: readonly T[],
): T | null {
  const cell = getJunctionPreviewCell(lattice, coordinate);
  if (!cell) return null;
  const target = cell.target;
  const session = openSessions.find((candidate) => candidate.id === target.sessionId);
  if (
    !session
    || session.bridgeHost !== target.bridgeHost
    || session.bridgePort !== target.bridgePort
    || session.sessionName !== target.sessionName
    || (target.daemonHostId && session.daemonHostId !== target.daemonHostId)
  ) {
    return null;
  }
  return session;
}

export function resolveJunctionPreviewSessions<T extends {
  id: string;
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}>(
  lattice: JunctionPreviewLatticeV1,
  openSessions: readonly T[],
): T[] {
  const resolved: T[] = [];
  const seen = new Set<string>();
  for (const cell of lattice.cells) {
    const session = openSessions.find((candidate) => candidate.id === cell.target.sessionId);
    if (
      session
      && session.bridgeHost === cell.target.bridgeHost
      && session.bridgePort === cell.target.bridgePort
      && session.sessionName === cell.target.sessionName
      && (!cell.target.daemonHostId || session.daemonHostId === cell.target.daemonHostId)
      && !seen.has(session.id)
    ) {
      seen.add(session.id);
      resolved.push(session);
    }
  }
  return resolved;
}

export function projectJunctionPreviewLiveIds(
  normalVisibleIds: readonly string[],
  previewVisibleIds: readonly string[],
  previewOpen: boolean,
) {
  return [...new Set(previewOpen ? [...normalVisibleIds, ...previewVisibleIds] : normalVisibleIds)];
}

export function readJunctionPreviewLattice(storage: JunctionPreviewStorage):
  | { status: 'empty'; lattice: JunctionPreviewLatticeV1 }
  | { status: 'available'; lattice: JunctionPreviewLatticeV1 }
  | { status: 'invalid'; error: unknown } {
  try {
    const raw = storage.getItem(JUNCTION_PREVIEW_LATTICE_STORAGE_KEY);
    if (!raw) return { status: 'empty', lattice: createEmptyJunctionPreviewLattice() };
    const lattice = normalizeJunctionPreviewLattice(JSON.parse(raw));
    if (!lattice) return { status: 'invalid', error: new Error('Invalid junction preview lattice') };
    return { status: 'available', lattice };
  } catch (error) {
    return { status: 'invalid', error };
  }
}

export function writeJunctionPreviewLattice(
  storage: Pick<JunctionPreviewStorage, 'setItem'>,
  lattice: JunctionPreviewLatticeV1,
): { ok: true } | { ok: false; error: unknown } {
  try {
    storage.setItem(JUNCTION_PREVIEW_LATTICE_STORAGE_KEY, JSON.stringify(lattice));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
