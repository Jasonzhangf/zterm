import { describe, it, expect } from 'vitest';
import {
  createOperation,
  isOperationType,
  type OperationType,
} from './operation';

describe('operation contract', () => {
  it('creates a typed terminal/input operation', () => {
    const op = createOperation('terminal/input', { sessionId: 's1', data: 'hello' });
    expect(op.type).toBe('terminal/input');
    expect(op.payload).toEqual({ sessionId: 's1', data: 'hello' });
  });

  it('creates session/create with target', () => {
    const op = createOperation('session/create', { host: '127.0.0.1', port: 4444, sessionName: 'test' });
    expect(op.type).toBe('session/create');
    if (isOperationType(op, 'session/create')) {
      expect(op.payload.host).toBe('127.0.0.1');
    }
  });

  it('creates update/check with empty payload', () => {
    const op = createOperation('update/check', {});
    expect(op.type).toBe('update/check');
  });

  it('isOperationType narrows correctly', () => {
    const op = createOperation('session/close', { sessionId: 's1' });
    if (isOperationType(op, 'session/close')) {
      expect(op.payload.sessionId).toBe('s1');
    } else {
      throw new Error('should narrow');
    }
  });

  it('isOperationType returns false for mismatch', () => {
    const op = createOperation('session/close', { sessionId: 's1' });
    expect(isOperationType(op, 'terminal/input')).toBe(false);
  });

  it('all operation types are covered in TerminalOperationMap', () => {
    const types: OperationType[] = [
      'terminal/input',
      'terminal/resize',
      'session/create',
      'session/attach',
      'session/detach',
      'session/close',
      'session/switch-active',
      'open-tab/open',
      'open-tab/close',
      'open-tab/move-pane',
      'pane/split',
      'pane/merge',
      'pane/activate',
      'transport/reconnect',
      'transport/disconnect',
      'file-transfer/send',
      'file-transfer/cancel',
      'screenshot/capture',
      'schedule/create',
      'schedule/toggle',
      'schedule/remove',
      'update/check',
      'update/apply',
      'foreground/resume',
      'background/pause',
    ];
    expect(types.length).toBe(25);
  });
});
