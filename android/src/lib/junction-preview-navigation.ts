import type { JunctionPreviewCoordinate } from './junction-preview-lattice';

export interface JunctionPreviewSessionItem {
  id: string;
  cwd?: string;
}

export interface JunctionPreviewCwdGroup {
  cwd: string;
  sessionId: string;
  coordinate: JunctionPreviewCoordinate;
}

export interface JunctionPreviewNavigationInput {
  focus: JunctionPreviewCoordinate;
  cells: ReadonlyArray<JunctionPreviewCoordinate & { target: { sessionId: string } }>;
  sessions: readonly JunctionPreviewSessionItem[];
  direction: 'next' | 'previous';
}

export type JunctionPreviewNavigationResult =
  | { action: 'none' }
  | { action: 'focus'; coordinate: JunctionPreviewCoordinate; sessionId: string }
  | { action: 'replace'; coordinate: JunctionPreviewCoordinate; sessionId: string };

export function resolvePreviewCwdGroups(input: {
  focus: JunctionPreviewCoordinate;
  cells: ReadonlyArray<JunctionPreviewCoordinate & { target: { sessionId: string } }>;
  sessions: readonly JunctionPreviewSessionItem[];
}): JunctionPreviewCwdGroup[] {
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  return input.cells
    .map((cell) => {
      const session = sessionById.get(cell.target.sessionId);
      return session
        ? {
            cwd: session.cwd?.trim() || '',
            sessionId: session.id,
            coordinate: { col: cell.col, row: cell.row },
          }
        : null;
    })
    .filter((group): group is JunctionPreviewCwdGroup => group !== null);
}

function sortSameCwdGroups(groups: readonly JunctionPreviewCwdGroup[], cwd: string): JunctionPreviewCwdGroup[] {
  return groups
    .filter((group) => group.cwd === cwd)
    .sort((left, right) => {
      const leftFocus = Math.abs(left.coordinate.col) + Math.abs(left.coordinate.row);
      const rightFocus = Math.abs(right.coordinate.col) + Math.abs(right.coordinate.row);
      if (leftFocus !== rightFocus) return leftFocus - rightFocus;
      if (left.coordinate.col !== right.coordinate.col) return left.coordinate.col - right.coordinate.col;
      return left.coordinate.row - right.coordinate.row;
    });
}

export function resolveCyclePreviewSession(input: JunctionPreviewNavigationInput): JunctionPreviewNavigationResult {
  const groups = resolvePreviewCwdGroups(input);
  const focusGroup = groups.find(
    (group) => group.coordinate.col === input.focus.col && group.coordinate.row === input.focus.row,
  );
  if (!focusGroup) return { action: 'none' };
  const sameCwdGroups = sortSameCwdGroups(groups, focusGroup.cwd);
  const currentIndex = sameCwdGroups.findIndex(
    (group) => group.coordinate.col === focusGroup.coordinate.col && group.coordinate.row === focusGroup.coordinate.row,
  );
  if (currentIndex < 0 || sameCwdGroups.length <= 1) return { action: 'none' };
  const nextIndex = input.direction === 'next'
    ? (currentIndex + 1) % sameCwdGroups.length
    : (currentIndex - 1 + sameCwdGroups.length) % sameCwdGroups.length;
  const next = sameCwdGroups[nextIndex];
  return {
    action: 'focus',
    coordinate: next.coordinate,
    sessionId: next.sessionId,
  };
}

export function resolvePinchVerticalCwdStep(input: JunctionPreviewNavigationInput): JunctionPreviewNavigationResult {
  const groups = resolvePreviewCwdGroups(input);
  const focusGroup = groups.find(
    (group) => group.coordinate.col === input.focus.col && group.coordinate.row === input.focus.row,
  );
  if (!focusGroup) return { action: 'none' };
  const orderedCwds = [...new Set(groups.map((group) => group.cwd))].sort();
  if (orderedCwds.length <= 1) return { action: 'none' };
  const currentIndex = orderedCwds.indexOf(focusGroup.cwd);
  const nextIndex = input.direction === 'next'
    ? (currentIndex + 1) % orderedCwds.length
    : (currentIndex - 1 + orderedCwds.length) % orderedCwds.length;
  const targetCwd = orderedCwds[nextIndex];
  const targetGroups = groups.filter((group) => group.cwd === targetCwd);
  const target = targetGroups
    .slice()
    .sort((left, right) => {
      const leftDistance = Math.abs(left.coordinate.col - focusGroup.coordinate.col)
        + Math.abs(left.coordinate.row - focusGroup.coordinate.row);
      const rightDistance = Math.abs(right.coordinate.col - focusGroup.coordinate.col)
        + Math.abs(right.coordinate.row - focusGroup.coordinate.row);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      if (left.coordinate.col !== right.coordinate.col) {
        return left.coordinate.col - right.coordinate.col;
      }
      return left.coordinate.row - right.coordinate.row;
    })[0];
  if (!target) return { action: 'none' };
  return {
    action: 'replace',
    coordinate: focusGroup.coordinate,
    sessionId: target.sessionId,
  };
}
