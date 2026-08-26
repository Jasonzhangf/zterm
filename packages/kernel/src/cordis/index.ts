/**
 * The only ZTerm owner allowed to translate application-kernel contracts to
 * Cordis primitives. This package is a process-local Playground evaluation.
 */
import { Context } from '@cordisjs/core';
import type { Events, ForkScope } from '@cordisjs/core';

export { Context };

export const CORDIS_PACKAGE = '@cordisjs/core';
export const CORDIS_VERSION = '3.18.1';

export interface CordisAdapterOptions {
  readonly name?: string;
}

export interface CordisAdapterError extends Error {
  readonly code: 'DUPLICATE_SERVICE' | 'DISPOSE_FAILED' | 'INVALID_STATE';
}

export interface CordisService {
  readonly dispose?: (reason: string) => void;
}

export interface CordisPluginHandle {
  readonly dispose: () => boolean;
}

type ContextEvent = keyof Events<Context>;

function contextEventName(event: string): ContextEvent {
  return event as ContextEvent;
}

function adapterError(
  code: CordisAdapterError['code'],
  message: string,
  cause?: unknown,
): CordisAdapterError {
  const error = new Error(message) as CordisAdapterError;
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: cause, enumerable: true });
  }
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

/**
 * Process-local composition adapter.
 *
 * It deliberately exposes only lifecycle/service/plugin/event operations. There
 * is no data-stream method: terminal bytes, frames, file chunks, media, and
 * high-frequency input remain on their dedicated typed transports.
 */
export class CordisAdapter {
  readonly #context: Context;
  readonly #name: string;
  readonly #services = new Map<string, { value: CordisService; remove: () => void }>();
  readonly #plugins = new Map<object | Function, ForkScope>();
  #state: 'created' | 'started' | 'stopped' = 'created';

  constructor(options: CordisAdapterOptions = {}) {
    this.#name = options.name ?? 'zterm-kernel';
    this.#context = new Context({ name: this.#name });
  }

  get context(): Context {
    return this.#context;
  }

  get name(): string {
    return this.#name;
  }

  get state(): 'created' | 'started' | 'stopped' {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state === 'stopped') {
      throw adapterError('INVALID_STATE', 'CordisAdapter cannot restart after stop');
    }
    if (this.#state === 'started') return;
    await this.#context.start();
    this.#state = 'started';
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    const errors: unknown[] = [];

    for (const [plugin, fork] of [...this.#plugins.entries()].reverse()) {
      try {
        fork.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        this.#plugins.delete(plugin);
      }
    }
    for (const [name, service] of [...this.#services.entries()].reverse()) {
      try {
        service.value.dispose?.(`unregistering service ${name}`);
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          service.remove();
        } catch (error) {
          errors.push(error);
        }
        this.#services.delete(name);
      }
    }

    try {
      await this.#context.stop();
    } catch (error) {
      errors.push(error);
    }
    this.#state = 'stopped';
    if (errors.length) {
      throw adapterError('DISPOSE_FAILED', `CordisAdapter dispose failed (${errors.length} error(s))`, errors[0]);
    }
  }

  registerService<T extends CordisService>(name: string, service: T): () => void {
    if (this.#state === 'stopped') {
      throw adapterError('INVALID_STATE', 'cannot register a service after stop');
    }
    if (this.#services.has(name)) {
      throw adapterError('DUPLICATE_SERVICE', `service already registered: ${name}`);
    }
    const remove = this.#context.set(name, service);
    this.#services.set(name, { value: service, remove });
    return () => {
      const record = this.#services.get(name);
      if (!record) return;
      try {
        record.value.dispose?.(`unregistering service ${name}`);
      } finally {
        record.remove();
        this.#services.delete(name);
      }
    };
  }

  plugin(plugin: object | Function, config?: unknown): CordisPluginHandle {
    if (this.#state === 'stopped') {
      throw adapterError('INVALID_STATE', 'cannot load a plugin after stop');
    }
    const fork = this.#context.plugin(plugin as Parameters<Context['plugin']>[0], config as any);
    this.#plugins.set(plugin, fork);
    return {
      dispose: () => {
        const result = fork.dispose();
        this.#plugins.delete(plugin);
        return result;
      },
    };
  }

  on(event: string, listener: (...args: any[]) => any): () => boolean {
    return this.#context.on(contextEventName(event), listener as any);
  }

  emit(event: string, ...args: any[]): void {
    this.#context.emit(contextEventName(event), ...(args as any));
  }

  off(event: string, listener: (...args: any[]) => any): boolean {
    return this.#context.off(contextEventName(event), listener as any);
  }
}

export default CordisAdapter;
