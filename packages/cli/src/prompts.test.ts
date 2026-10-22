import { getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  PromptCancelledError,
  createNodePrompts,
} from './prompts.js';

class TestTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawModes: boolean[] = [];

  setRawMode(value: boolean) {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 500) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => 'timeout' as const),
  ]);
}

describe('Node prompt adapter', () => {
  it('reads a password in raw mode without echoing the secret', async () => {
    const input = new TestTty();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk) => {
      rendered += chunk.toString();
    });
    const prompts = createNodePrompts({ input, output });

    const password = prompts.password('密码: ');
    input.write('hidden-password-secret\r');

    await expect(password).resolves.toBe('hidden-password-secret');
    expect(input.rawModes).toEqual([true, false]);
    expect(rendered).toContain('密码');
    expect(rendered).not.toContain('hidden-password-secret');
  });

  it('cancels a hidden password with Ctrl+C and restores raw mode', async () => {
    const input = new TestTty();
    const output = new PassThrough();
    const prompts = createNodePrompts({ input, output });

    const pending = prompts.password('密码: ');
    input.write('\u0003');

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(input.rawModes).toEqual([true, false]);
  });

  it('maps select and confirm answers and supports Ctrl+C cancellation', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompts = createNodePrompts({ input, output });

    const selection = prompts.select('服务器', [
      { label: 'Mac Studio (online)', value: 'mac' },
      { label: 'Studio (offline)', value: 'studio' },
    ]);
    input.write('2\n');
    await expect(selection).resolves.toBe('studio');

    const confirmation = prompts.confirm('保存槽位 2？');
    input.write('y\n');
    await expect(confirmation).resolves.toBe(true);

    const cancelled = prompts.text('账号: ');
    input.write('\u0003\n');
    await expect(cancelled).rejects.toBeInstanceOf(PromptCancelledError);
  });

  it('turns input EOF into cancellation instead of an empty secret', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompts = createNodePrompts({ input, output });

    const pending = prompts.text('账号: ');
    input.end();

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
  });

  it('reads a password after readline paused the shared input stream', async () => {
    const input = new TestTty();
    const output = new PassThrough();
    const prompts = createNodePrompts({ input, output });

    const username = prompts.text('账号: ');
    input.write('jason\n');
    await expect(username).resolves.toBe('jason');
    expect(input.isPaused()).toBe(true);

    const password = prompts.password('密码: ');
    input.write('hidden-password-secret\r');

    await expect(settlesWithin(password)).resolves.toBe('hidden-password-secret');
    expect(input.rawModes).toEqual([true, false, true, false]);
    expect(input.isPaused()).toBe(true);
  });

  it('rejects already-aborted command signals without taking terminal ownership', async () => {
    const controller = new AbortController();
    controller.abort();
    const input = new TestTty();
    const output = new PassThrough();
    const prompts = createNodePrompts({
      input,
      output,
      signal: controller.signal,
    });

    await expect(prompts.text('账号: ')).rejects.toBeInstanceOf(PromptCancelledError);
    await expect(prompts.password('密码: ')).rejects.toBeInstanceOf(PromptCancelledError);
    expect(input.rawModes).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('settles active line and password prompts on command abort', async () => {
    const textController = new AbortController();
    const textInput = new TestTty();
    const textPrompts = createNodePrompts({
      input: textInput,
      output: new PassThrough(),
      signal: textController.signal,
    });
    const text = textPrompts.text('账号: ');
    textController.abort();

    await expect(text).rejects.toBeInstanceOf(PromptCancelledError);
    expect(textInput.rawModes).toEqual([true, false]);
    expect(textInput.listenerCount('keypress')).toBe(0);
    expect(getEventListeners(textController.signal, 'abort')).toHaveLength(0);

    const passwordController = new AbortController();
    const passwordInput = new TestTty();
    passwordInput.isRaw = true;
    const passwordPrompts = createNodePrompts({
      input: passwordInput,
      output: new PassThrough(),
      signal: passwordController.signal,
    });
    const password = passwordPrompts.password('密码: ');
    passwordController.abort();

    await expect(password).rejects.toBeInstanceOf(PromptCancelledError);
    expect(passwordInput.rawModes).toEqual([true, true]);
    expect(passwordInput.listenerCount('data')).toBe(0);
    expect(getEventListeners(passwordController.signal, 'abort')).toHaveLength(0);
  });
});
