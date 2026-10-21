import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class PromptCancelledError extends Error {
  constructor(readonly stage: string) {
    super(`${stage} input cancelled`);
    this.name = 'PromptCancelledError';
  }
}

export class PromptUnsupportedError extends Error {
  readonly code = 'tty_required';

  constructor() {
    super('hidden password input requires a TTY');
    this.name = 'PromptUnsupportedError';
  }
}

export interface PromptChoice<T> {
  label: string;
  value: T;
}

export interface PromptPort {
  text(message: string): Promise<string>;
  password(message: string): Promise<string>;
  select<T>(message: string, choices: readonly PromptChoice<T>[]): Promise<T>;
  confirm(message: string): Promise<boolean>;
}

export interface NodePromptOptions {
  input: Readable;
  output: Writable;
}

export function createNodePrompts(
  options: NodePromptOptions = { input: process.stdin, output: process.stdout },
): PromptPort {
  return new NodePromptHandler(options.input, options.output);
}

class NodePromptHandler implements PromptPort {
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  text(message: string): Promise<string> {
    return this.askLine(message);
  }

  password(message: string): Promise<string> {
    if (!isTty(this.input)) {
      return Promise.reject(new PromptUnsupportedError());
    }
    const tty = this.input;
    this.output.write(message);
    try {
      tty.setRawMode(true);
    } catch {
      return Promise.reject(new PromptUnsupportedError());
    }
    const decoder = new StringDecoder('utf8');
    let value = '';

    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        this.input.removeListener('data', onData);
        this.input.removeListener('end', onEnd);
        try {
          tty.setRawMode(false);
        } catch {
          // The password promise still settles after a failed terminal restore.
        }
        this.output.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string'
          ? chunk
          : decoder.write(chunk);
        for (const character of text) {
          if (character === '\r' || character === '\n') {
            finish();
            return;
          }
          if (character === '\u0003' || character === '\u0004') {
            finish(new PromptCancelledError('password'));
            return;
          }
          if (character === '\u0008' || character === '\u007f') {
            value = Array.from(value).slice(0, -1).join('');
            continue;
          }
          if (character >= ' ') {
            value += character;
          }
        }
      };
      const onEnd = () => finish(new PromptCancelledError('password'));
      this.input.on('data', onData);
      this.input.once('end', onEnd);
    });
  }

  async select<T>(message: string, choices: readonly PromptChoice<T>[]): Promise<T> {
    this.output.write(`${message}\n`);
    for (let index = 0; index < choices.length; index += 1) {
      this.output.write(`  ${index + 1}. ${choices[index].label}\n`);
    }
    while (true) {
      const answer = await this.askLine(`选择 [1-${choices.length}]: `);
      const index = Number(answer.trim());
      if (Number.isSafeInteger(index) && index >= 1 && index <= choices.length) {
        return choices[index - 1].value;
      }
      this.output.write('请输入列表中的编号。\n');
    }
  }

  async confirm(message: string): Promise<boolean> {
    while (true) {
      const answer = (await this.askLine(`${message} [y/N]: `)).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === '' || answer === 'n' || answer === 'no') return false;
      this.output.write('请输入 y 确认，或输入 N 取消。\n');
    }
  }

  private askLine(message: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const interface_ = createInterface({
        input: this.input,
        output: this.output,
        terminal: isTty(this.input),
      });
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        interface_.removeListener('SIGINT', onSignal);
        interface_.removeListener('close', onClose);
        interface_.close();
        action();
      };
      const onSignal = () => settle(() => reject(new PromptCancelledError('text')));
      const onClose = () => {
        if (!settled) settle(() => reject(new PromptCancelledError('text')));
      };
      interface_.once('SIGINT', onSignal);
      interface_.once('close', onClose);
      interface_.question(message, (answer) => {
        if (answer.includes('\u0003') || answer.includes('\u0004')) {
          settle(() => reject(new PromptCancelledError('text')));
          return;
        }
        settle(() => resolve(answer));
      });
    });
  }
}

function isTty(stream: Readable): stream is Readable & {
  isTTY: true;
  setRawMode(value: boolean): unknown;
} {
  return Boolean(
    'isTTY' in stream
    && (stream as { isTTY?: unknown }).isTTY === true
    && typeof (stream as { setRawMode?: unknown }).setRawMode === 'function',
  );
}
