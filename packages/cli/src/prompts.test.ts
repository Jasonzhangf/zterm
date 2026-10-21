import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  PromptCancelledError,
  createNodePrompts,
} from './prompts.js';

class TestTty extends PassThrough {
  isTTY = true;
  readonly rawModes: boolean[] = [];

  setRawMode(value: boolean) {
    this.rawModes.push(value);
    return this;
  }
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
});
