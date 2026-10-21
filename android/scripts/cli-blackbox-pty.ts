import { setTimeout as delay } from 'node:timers/promises';

export interface CliBlackboxPtyTerminal {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface CliBlackboxPtyRuntime {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): CliBlackboxPtyTerminal;
}

export interface CliBlackboxPtyShellOptions {
  runtime: CliBlackboxPtyRuntime;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell?: string;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
}

export interface CliBlackboxCommandResult {
  exitCode: number;
  output: string;
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}

export function projectVisibleTerminalText(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r/gu, '');
}

export class CliBlackboxPtyShell {
  readonly prompt: string;
  readonly pid: number;

  private output = '';
  private closed = false;

  private constructor(
    private readonly terminal: CliBlackboxPtyTerminal,
    prompt: string,
  ) {
    this.pid = terminal.pid;
    this.prompt = prompt;
    terminal.onData((chunk) => {
      this.output += chunk;
      if (this.output.length > 2_000_000) {
        this.output = this.output.slice(-1_000_000);
      }
    });
    terminal.onExit(() => {
      this.closed = true;
    });
  }

  static async start(options: CliBlackboxPtyShellOptions) {
    const prompt = `__ZTERM_CLI_BLACKBOX_SHELL_${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}__ `;
    const terminal = options.runtime.spawn(
      options.shell || '/bin/sh',
      ['-i'],
      {
        name: 'xterm-256color',
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: options.cwd,
        env: {
          ...options.env,
          PS1: prompt,
          PS2: '',
        },
      },
    );
    const shell = new CliBlackboxPtyShell(terminal, prompt);
    await shell.waitFor(prompt, 'shell prompt', {
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    return shell;
  }

  mark() {
    return this.output.length;
  }

  write(data: string) {
    if (this.closed) {
      throw new Error('CLI blackbox PTY shell is closed');
    }
    this.terminal.write(data);
  }

  sendLine(line: string) {
    this.write(`${line}\n`);
  }

  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
  }

  transcript() {
    return this.output;
  }

  async waitFor(
    pattern: string | RegExp,
    label: string,
    options: {
      from?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<string> {
    return await this.waitForProjected(
      pattern,
      label,
      options,
      (value) => value.replace(/\r/gu, ''),
    );
  }

  async waitForVisibleText(
    pattern: string | RegExp,
    label: string,
    options: {
      from?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<string> {
    return await this.waitForProjected(
      pattern,
      label,
      options,
      projectVisibleTerminalText,
    );
  }

  private async waitForProjected(
    pattern: string | RegExp,
    label: string,
    options: {
      from?: number;
      timeoutMs?: number;
    },
    project: (value: string) => string,
  ): Promise<string> {
    const from = options.from ?? 0;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const visible = project(this.output.slice(from));
      const match = typeof pattern === 'string'
        ? visible.includes(pattern)
          ? pattern
          : undefined
        : pattern.exec(visible)?.[0];
      if (match !== undefined) {
        if (pattern instanceof RegExp) pattern.lastIndex = 0;
        return match;
      }
      if (this.closed) {
        throw new Error(`${label} failed: PTY shell exited`);
      }
      await delay(30);
    }
    throw new Error(`${label} timeout`);
  }

  async waitForPrompt(options: { from?: number; timeoutMs?: number } = {}) {
    return this.waitFor(this.prompt, 'shell prompt', options);
  }

  async startCommand(
    command: string,
    marker: string,
    timeoutMs: number,
  ): Promise<{
    from: number;
    finish: () => Promise<CliBlackboxCommandResult>;
  }> {
    const from = this.mark();
    const exitPattern = new RegExp(
      `${escapeRegExp(marker)}:(-?\\d+)`,
    );
    this.sendLine(
      `${command}; printf '\\n${marker}:%s\\n' "$?"`,
    );
    return {
      from,
      finish: async () => {
        const match = await this.waitFor(exitPattern, marker, {
          from,
          timeoutMs,
        });
        const exitCode = Number(exitPattern.exec(match)?.[1]);
        await this.waitForPrompt({ from, timeoutMs });
        return {
          exitCode,
          output: this.output.slice(from).replace(/\r/gu, ''),
        };
      },
    };
  }

  async runCommand(
    command: string,
    marker: string,
    options: {
      timeoutMs?: number;
    } = {},
  ) {
    const started = await this.startCommand(
      command,
      marker,
      options.timeoutMs ?? 30_000,
    );
    return started.finish();
  }

  async close(timeoutMs = 3000) {
    if (this.closed) {
      return;
    }
    this.terminal.write('exit\n');
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await delay(30);
    }
    if (!this.closed) {
      this.terminal.kill();
      const killDeadline = Date.now() + timeoutMs;
      while (!this.closed && Date.now() < killDeadline) {
        await delay(30);
      }
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
