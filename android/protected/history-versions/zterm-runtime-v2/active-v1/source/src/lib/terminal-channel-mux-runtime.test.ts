import { describe, expect, it } from 'vitest';
import {
  bindTerminalChannelSession,
  clearTerminalChannelSession,
  createTerminalChannelMuxStore,
  ensureSessionTerminalChannel,
  getOpeningSessionTerminalChannelsForTarget,
  getSessionIdForTerminalChannel,
  getSessionTerminalChannel,
  getTerminalChannelsForTarget,
  removeSessionTerminalChannel,
  setSessionChannelBodySubscribed,
  updateSessionTerminalChannelName,
  updateSessionTerminalChannelState,
} from './terminal-channel-mux-runtime';

describe('terminal-channel-mux-runtime', () => {
  it('owns channel open, name, body subscription, and state for one session', () => {
    const store = createTerminalChannelMuxStore();
    const binding = bindTerminalChannelSession(store, ' session-1 ', 'target-a', ' alpha ');

    expect(binding).toMatchObject({
      sessionId: 'session-1',
      targetKey: 'target-a',
      sessionName: 'alpha',
      channelId: null,
    });

    const channel = ensureSessionTerminalChannel(store, 'session-1', {
      channelId: 'chan-1',
      now: 42,
      bodySubscribed: false,
    });
    expect(channel).toMatchObject({
      channelId: 'chan-1',
      sessionId: 'session-1',
      targetKey: 'target-a',
      state: 'opening',
      bodySubscribed: false,
      openedAt: 42,
      closedAt: null,
    });

    expect(updateSessionTerminalChannelName(store, 'session-1', 'Alpha')?.sessionName).toBe('Alpha');
    expect(store.sessions.get('session-1')?.sessionName).toBe('Alpha');
    expect(setSessionChannelBodySubscribed(store, 'session-1', true)?.bodySubscribed).toBe(true);
    expect(updateSessionTerminalChannelState(store, 'session-1', 'open', 50)?.state).toBe('open');

    const closed = updateSessionTerminalChannelState(store, 'session-1', 'closed', 60);
    expect(closed?.state).toBe('closed');
    expect(closed?.closedAt).toBe(60);
    expect(getSessionTerminalChannel(store, 'session-1')).toBe(closed);
  });

  it('demuxes channels by target and replays opening channels with active priority', () => {
    const store = createTerminalChannelMuxStore();
    bindTerminalChannelSession(store, 's1', 'target-a', 'one');
    bindTerminalChannelSession(store, 's2', 'target-a', 'two');
    bindTerminalChannelSession(store, 's3', 'target-b', 'three');

    ensureSessionTerminalChannel(store, 's1', { channelId: 'chan-1' });
    ensureSessionTerminalChannel(store, 's2', { channelId: 'chan-2' });
    ensureSessionTerminalChannel(store, 's3', { channelId: 'chan-1' });
    updateSessionTerminalChannelState(store, 's1', 'open');

    expect(getSessionIdForTerminalChannel(store, 'target-a', 'chan-1')).toBe('s1');
    expect(getSessionIdForTerminalChannel(store, 'target-b', 'chan-1')).toBe('s3');
    expect(getTerminalChannelsForTarget(store, 'target-a').map((channel) => channel.channelId)).toEqual([
      'chan-1',
      'chan-2',
    ]);
    expect(getOpeningSessionTerminalChannelsForTarget(store, 'target-a').map((channel) => channel.channelId)).toEqual([
      'chan-2',
    ]);

    updateSessionTerminalChannelState(store, 's1', 'opening');
    expect(
      getOpeningSessionTerminalChannelsForTarget(store, 'target-a', 's2').map(
        (channel) => channel.channelId,
      ),
    ).toEqual(['chan-2', 'chan-1']);
  });

  it('removes one channel without removing siblings or the target binding', () => {
    const store = createTerminalChannelMuxStore();
    bindTerminalChannelSession(store, 's1', 'target-a', 'one');
    bindTerminalChannelSession(store, 's2', 'target-a', 'two');
    ensureSessionTerminalChannel(store, 's1', { channelId: 'chan-a' });
    ensureSessionTerminalChannel(store, 's2', { channelId: 'chan-b' });

    const removed = removeSessionTerminalChannel(store, 's1');
    expect(removed?.channelId).toBe('chan-a');
    expect(getSessionTerminalChannel(store, 's1')).toBeNull();
    expect(getSessionTerminalChannel(store, 's2')?.channelId).toBe('chan-b');
    expect(getTerminalChannelsForTarget(store, 'target-a').map((channel) => channel.channelId)).toEqual([
      'chan-b',
    ]);
    expect(store.targets.has('target-a')).toBe(true);
    expect(store.sessions.has('s1')).toBe(true);
  });

  it('prunes an empty target only after the final session binding is cleared', () => {
    const store = createTerminalChannelMuxStore();
    bindTerminalChannelSession(store, 's1', 'target-a', 'one');
    ensureSessionTerminalChannel(store, 's1', { channelId: 'chan-a' });

    removeSessionTerminalChannel(store, 's1');
    expect(store.targets.has('target-a')).toBe(true);

    clearTerminalChannelSession(store, 's1');
    expect(store.sessions.has('s1')).toBe(false);
    expect(store.targets.has('target-a')).toBe(false);
  });

  it('rebinds a session to a new target and prunes the old channel target', () => {
    const store = createTerminalChannelMuxStore();
    bindTerminalChannelSession(store, 's1', 'target-a', 'one');
    ensureSessionTerminalChannel(store, 's1', { channelId: 'chan-a' });

    const binding = bindTerminalChannelSession(store, 's1', 'target-b', 'two');
    expect(binding.targetKey).toBe('target-b');
    expect(getSessionTerminalChannel(store, 's1')).toBeNull();
    expect(store.targets.has('target-a')).toBe(false);

    ensureSessionTerminalChannel(store, 's1', { channelId: 'chan-b' });
    expect(getSessionTerminalChannel(store, 's1')?.targetKey).toBe('target-b');
  });

  it('clears unbound and empty target state without fabricating a channel', () => {
    const store = createTerminalChannelMuxStore();
    expect(ensureSessionTerminalChannel(store, 'missing')).toBeNull();

    bindTerminalChannelSession(store, 's1', 'target-a', 'one');
    expect(store.targets.has('target-a')).toBe(true);
    clearTerminalChannelSession(store, 's1');
    expect(store.targets.has('target-a')).toBe(false);
    expect(store.sessions.has('s1')).toBe(false);
  });

  it('rejects a channel id already owned by another session on the same target', () => {
    const store = createTerminalChannelMuxStore();
    bindTerminalChannelSession(store, 's1', 'target-a', 'one');
    bindTerminalChannelSession(store, 's2', 'target-a', 'two');
    ensureSessionTerminalChannel(store, 's1', { channelId: 'chan-x' });

    expect(() => ensureSessionTerminalChannel(store, 's2', { channelId: 'chan-x' })).toThrow(
      'terminal channel chan-x is already bound to s1',
    );
  });
});
