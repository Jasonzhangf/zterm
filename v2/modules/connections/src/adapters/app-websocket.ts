/**
 * Explicit old /app compatibility adapter.
 *
 * This is a codec boundary only: it validates frames using the V1 app protocol
 * parser. It does NOT pretend a raw /app WebSocket is a V2 terminal mux link;
 * the caller must still negotiate capabilities through the connections channel
 * dispatcher. Credentials stay in the accounts-produced target URL; this module
 * never reads a credential store.
 */
import { validateAppClientFrame, validateAppServerFrame } from "../../../../../packages/shared/src/connection/app-protocol.ts";

export interface AppSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface AppCodec {
  encode(frame: Parameters<typeof validateAppClientFrame>[0]): string;
  decode(raw: string): ReturnType<typeof validateAppServerFrame>;
}

export function createAppCodec(): AppCodec {
  return {
    encode: (frame) => {
      validateAppClientFrame(frame);
      return JSON.stringify(frame);
    },
    decode: (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return validateAppServerFrame(parsed);
    },
  };
}
