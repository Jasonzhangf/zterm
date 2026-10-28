import { describe, expect, it } from 'vitest';
import {
  classifySessionDrawerVisibility,
  filterSessionsByDrawerVisibility,
  hideSessionName,
  normalizeSessionDrawerFilterConfig,
  parseSessionDrawerFilterConfig,
  resolveSessionNameForVisibility,
  restoreAllHiddenSessions,
  restoreHiddenSessionName,
  serializeSessionDrawerFilterConfig,
  sessionMatchesDrawerVisibility,
  type SessionDrawerFilterConfig,
} from './session-drawer-visibility';

function config(overrides: Partial<SessionDrawerFilterConfig> = {}): SessionDrawerFilterConfig {
  return normalizeSessionDrawerFilterConfig({
    version: 2,
    mode: 'all',
    hiddenSessionNames: [],
    ...overrides,
  });
}

describe('session drawer visibility', () => {
  it('classifies only from the Collab projection and keeps unknown unclassified', () => {
    expect(classifySessionDrawerVisibility({ role: 'master', displayName: 'Jenny' })).toBe('master');
    expect(classifySessionDrawerVisibility({ role: 'worker', displayName: 'Alice' })).toBe('worker');
    expect(classifySessionDrawerVisibility(null)).toBe('unclassified');
    expect(classifySessionDrawerVisibility(undefined)).toBe('unclassified');
    expect(classifySessionDrawerVisibility({ role: 'worker', displayName: '' })).toBe('worker');
  });

  it('never infers a role from a session name', () => {
    expect(filterSessionsByDrawerVisibility(
      [
        { id: 'master-named', sessionName: 'master' },
        { id: 'agent-named', sessionName: 'zterm-3' },
      ],
      config({ mode: 'only-master' }),
      (row) => row.sessionName,
      () => undefined,
    ).map((row) => row.id)).toEqual([]);
    expect(config()).not.toHaveProperty('masterNames');
    expect(config()).not.toHaveProperty('subagentNames');
  });

  it('uses exact trimmed sessionName identity and does not infer from title', () => {
    expect(resolveSessionNameForVisibility({ sessionName: ' zterm-3 ' })).toBe('zterm-3');
    expect(resolveSessionNameForVisibility({ sessionName: '' })).toBe('');
    expect(resolveSessionNameForVisibility({})).toBe('');
  });

  it('only-master shows Collab master and hides worker plus unclassified', () => {
    expect(sessionMatchesDrawerVisibility('master', 'only-master')).toBe(true);
    expect(sessionMatchesDrawerVisibility('worker', 'only-master')).toBe(false);
    expect(sessionMatchesDrawerVisibility('unclassified', 'only-master')).toBe(false);
  });

  it('hide-worker hides Collab worker and still shows master plus unclassified', () => {
    expect(sessionMatchesDrawerVisibility('master', 'hide-worker')).toBe(true);
    expect(sessionMatchesDrawerVisibility('unclassified', 'hide-worker')).toBe(true);
    expect(sessionMatchesDrawerVisibility('worker', 'hide-worker')).toBe(false);
  });

  it('filters rows by projection without mutating source sessions', () => {
    const sessions = [
      { id: 'm', sessionName: 'zterm-1', collab: { role: 'master' as const, displayName: 'Jenny' } },
      { id: 'w', sessionName: 'zterm-2', collab: { role: 'worker' as const, displayName: 'Alice' } },
      { id: 'u', sessionName: 'OneStop-1' },
    ];
    const source = [...sessions];
    const resolveCollab = (row: typeof sessions[number]) => row.collab;

    expect(filterSessionsByDrawerVisibility(sessions, config(), (row) => row.sessionName, resolveCollab).map((row) => row.id))
      .toEqual(['m', 'w', 'u']);
    expect(filterSessionsByDrawerVisibility(
      sessions,
      config({ mode: 'only-master' }),
      (row) => row.sessionName,
      resolveCollab,
    ).map((row) => row.id)).toEqual(['m']);
    expect(filterSessionsByDrawerVisibility(
      sessions,
      config({ mode: 'hide-worker' }),
      (row) => row.sessionName,
      resolveCollab,
    ).map((row) => row.id)).toEqual(['m', 'u']);

    expect(sessions).toEqual(source);
  });

  it('hides and restores exact session names without touching Collab projection', () => {
    const sessions = [
      { id: 'exact', sessionName: 'zterm-1', collab: { role: 'master' as const, displayName: 'Jenny' } },
      { id: 'prefix', sessionName: 'zterm-10', collab: { role: 'worker' as const, displayName: 'Alice' } },
      { id: 'other', sessionName: 'OneStop-1' },
    ];
    const hidden = hideSessionName(config(), ' zterm-1 ');

    expect(hidden.hiddenSessionNames).toEqual(['zterm-1']);
    expect(filterSessionsByDrawerVisibility(sessions, hidden, (row) => row.sessionName, (row) => row.collab).map((row) => row.id))
      .toEqual(['prefix', 'other']);

    const restoredOne = restoreHiddenSessionName(hidden, 'zterm-1');
    expect(restoredOne.hiddenSessionNames).toEqual([]);
    expect(filterSessionsByDrawerVisibility(sessions, restoredOne, (row) => row.sessionName, (row) => row.collab).map((row) => row.id))
      .toEqual(['exact', 'prefix', 'other']);

    const hiddenTwo = hideSessionName(hideSessionName(config(), 'zterm-1'), 'OneStop-1');
    const restoredAll = restoreAllHiddenSessions(hiddenTwo);
    expect(restoredAll.hiddenSessionNames).toEqual([]);
    expect(filterSessionsByDrawerVisibility(sessions, restoredAll, (row) => row.sessionName, (row) => row.collab).map((row) => row.id))
      .toEqual(['exact', 'prefix', 'other']);
  });

  it('normalizes and deduplicates hidden session names', () => {
    expect(normalizeSessionDrawerFilterConfig({
      version: 2,
      mode: 'all',
      hiddenSessionNames: [' zterm-3 ', 'zterm-3', '', 'OneStop-1'],
    })).toEqual({
      version: 2,
      mode: 'all',
      hiddenSessionNames: ['zterm-3', 'OneStop-1'],
    });
  });

  it('migrates legacy v1 name-list config to v2 without keeping role lists', () => {
    const legacy = {
      version: 1,
      mode: 'hide-subagent',
      masterNames: ['zterm-3'],
      subagentNames: ['zterm-subagent-rw-ui-0906'],
      hiddenSessionNames: ['OneStop-1'],
    };
    expect(normalizeSessionDrawerFilterConfig(legacy)).toEqual({
      version: 2,
      mode: 'hide-worker',
      hiddenSessionNames: ['OneStop-1'],
    });
  });

  it('round-trips config JSON without promoting unknown names', () => {
    const original = config({
      mode: 'hide-worker',
      hiddenSessionNames: [' OneStop-1 ', 'OneStop-1'],
    });
    const parsed = parseSessionDrawerFilterConfig(serializeSessionDrawerFilterConfig(original));
    expect(parsed).toEqual({
      version: 2,
      mode: 'hide-worker',
      hiddenSessionNames: ['OneStop-1'],
    });
    expect(parseSessionDrawerFilterConfig('{bad')).toEqual({
      version: 2,
      mode: 'all',
      hiddenSessionNames: [],
    });
    expect(normalizeSessionDrawerFilterConfig({ mode: 'whitelist-master', hiddenSessionNames: ['zterm-3'] })).toEqual({
      version: 2,
      mode: 'all',
      hiddenSessionNames: ['zterm-3'],
    });
  });
});
