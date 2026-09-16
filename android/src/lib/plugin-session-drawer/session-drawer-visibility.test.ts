import { describe, expect, it } from 'vitest';
import {
  classifySessionDrawerVisibility,
  filterSessionsByDrawerVisibility,
  hideSessionName,
  normalizeSessionDrawerFilterConfig,
  parseSessionDrawerFilterConfig,
  resolveSessionNameForVisibility,
  restoreAllHiddenSessions,
  serializeSessionDrawerFilterConfig,
  sessionMatchesDrawerVisibility,
  type SessionDrawerFilterConfig,
} from './session-drawer-visibility';

function config(overrides: Partial<SessionDrawerFilterConfig> = {}): SessionDrawerFilterConfig {
  return normalizeSessionDrawerFilterConfig({
    version: 1,
    mode: 'all',
    masterNames: ['zterm-3'],
    subagentNames: ['zterm-subagent-rw-ui-0906'],
    ...overrides,
  });
}

describe('session drawer visibility', () => {
  it('classifies only from explicit Settings name lists and keeps unknown unclassified', () => {
    const lists = config();
    expect(classifySessionDrawerVisibility('zterm-3', lists)).toBe('master');
    expect(classifySessionDrawerVisibility('zterm-subagent-rw-ui-0906', lists)).toBe('subagent');
    expect(classifySessionDrawerVisibility('OneStop-1', lists)).toBe('unclassified');
    expect(classifySessionDrawerVisibility('master', lists)).toBe('unclassified');
    expect(classifySessionDrawerVisibility('zterm-2', lists)).toBe('unclassified');
    expect(classifySessionDrawerVisibility('dsh-plugins-3', lists)).toBe('unclassified');
    expect(classifySessionDrawerVisibility('claude-subagent-1', lists)).toBe('unclassified');
    expect(classifySessionDrawerVisibility('', lists)).toBe('unclassified');
  });

  it('never auto-promotes names that appear on both lists', () => {
    const lists = config({
      masterNames: ['shared-pane'],
      subagentNames: ['shared-pane'],
    });
    expect(classifySessionDrawerVisibility('shared-pane', lists)).toBe('unclassified');
  });

  it('uses exact trimmed sessionName identity and does not infer from title', () => {
    expect(resolveSessionNameForVisibility({ sessionName: ' zterm-3 ' })).toBe('zterm-3');
    expect(resolveSessionNameForVisibility({ sessionName: '' })).toBe('');
    expect(resolveSessionNameForVisibility({})).toBe('');
  });

  it('only-master shows explicit master and hides subagent plus unclassified', () => {
    expect(sessionMatchesDrawerVisibility('master', 'only-master')).toBe(true);
    expect(sessionMatchesDrawerVisibility('subagent', 'only-master')).toBe(false);
    expect(sessionMatchesDrawerVisibility('unclassified', 'only-master')).toBe(false);
  });

  it('hide-subagent hides explicit subagent and still shows unclassified', () => {
    expect(sessionMatchesDrawerVisibility('master', 'hide-subagent')).toBe(true);
    expect(sessionMatchesDrawerVisibility('unclassified', 'hide-subagent')).toBe(true);
    expect(sessionMatchesDrawerVisibility('subagent', 'hide-subagent')).toBe(false);
  });

  it('filters rows by config without mutating source sessions or name lists', () => {
    const masterNames = ['zterm-3'];
    const subagentNames = ['zterm-subagent-rw-ui-0906'];
    const sessions = [
      { id: 'm', sessionName: 'zterm-3' },
      { id: 's', sessionName: 'zterm-subagent-rw-ui-0906' },
      { id: 'u', sessionName: 'OneStop-1' },
    ];
    const source = [...sessions];
    const lists = config({ masterNames, subagentNames });

    expect(filterSessionsByDrawerVisibility(sessions, lists, (row) => row.sessionName).map((row) => row.id))
      .toEqual(['m', 's', 'u']);
    expect(filterSessionsByDrawerVisibility(
      sessions,
      config({ mode: 'only-master', masterNames, subagentNames }),
      (row) => row.sessionName,
    ).map((row) => row.id)).toEqual(['m']);
    expect(filterSessionsByDrawerVisibility(
      sessions,
      config({ mode: 'hide-subagent', masterNames, subagentNames }),
      (row) => row.sessionName,
    ).map((row) => row.id)).toEqual(['m', 'u']);

    expect(sessions).toEqual(source);
    masterNames.push('later-master');
    subagentNames.push('later-subagent');
    expect(classifySessionDrawerVisibility('later-master', lists)).toBe('unclassified');
    expect(classifySessionDrawerVisibility('later-subagent', lists)).toBe('unclassified');
  });

  it('hides exact session names and restores all hidden names', () => {
    const sessions = [
      { id: 'exact', sessionName: 'zterm-3' },
      { id: 'prefix', sessionName: 'zterm-30' },
      { id: 'other', sessionName: 'OneStop-1' },
    ];
    const hidden = hideSessionName(config(), ' zterm-3 ');

    expect(hidden.hiddenSessionNames).toEqual(['zterm-3']);
    expect(filterSessionsByDrawerVisibility(sessions, hidden, (row) => row.sessionName).map((row) => row.id))
      .toEqual(['prefix', 'other']);

    const restored = restoreAllHiddenSessions(hidden);
    expect(restored.hiddenSessionNames).toEqual([]);
    expect(filterSessionsByDrawerVisibility(sessions, restored, (row) => row.sessionName).map((row) => row.id))
      .toEqual(['exact', 'prefix', 'other']);
  });

  it('normalizes and deduplicates hidden session names', () => {
    expect(normalizeSessionDrawerFilterConfig({
      version: 1,
      mode: 'all',
      masterNames: [],
      subagentNames: [],
      hiddenSessionNames: [' zterm-3 ', 'zterm-3', '', 'OneStop-1'],
    })).toEqual({
      version: 1,
      mode: 'all',
      masterNames: [],
      subagentNames: [],
      hiddenSessionNames: ['zterm-3', 'OneStop-1'],
    });
  });

  it('round-trips Settings config JSON without promoting unknown names', () => {
    const original = config({
      mode: 'hide-subagent',
      masterNames: ['  zterm-3  ', 'zterm-3', ''],
      subagentNames: ['zterm-subagent-rw-ui-0906', ' not-a-collab '],
      hiddenSessionNames: [' OneStop-1 ', 'OneStop-1'],
    });
    const parsed = parseSessionDrawerFilterConfig(serializeSessionDrawerFilterConfig(original));
    expect(parsed).toEqual({
      version: 1,
      mode: 'hide-subagent',
      masterNames: ['zterm-3'],
      subagentNames: ['zterm-subagent-rw-ui-0906', 'not-a-collab'],
      hiddenSessionNames: ['OneStop-1'],
    });
    expect(classifySessionDrawerVisibility('zterm-2', parsed)).toBe('unclassified');
    expect(parseSessionDrawerFilterConfig('{bad')).toEqual({
      version: 1,
      mode: 'all',
      masterNames: [],
      subagentNames: [],
      hiddenSessionNames: [],
    });
    expect(normalizeSessionDrawerFilterConfig({ mode: 'whitelist-master', masterNames: ['zterm-3'] })).toEqual({
      version: 1,
      mode: 'all',
      masterNames: ['zterm-3'],
      subagentNames: [],
      hiddenSessionNames: [],
    });
  });
});
