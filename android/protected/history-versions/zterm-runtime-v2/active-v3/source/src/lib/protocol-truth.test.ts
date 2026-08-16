import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readTypesSource() {
  return readFileSync(join(process.cwd(), 'src', 'lib', 'types.ts'), 'utf8');
}

describe('android lib protocol truth gate', () => {
  it('keeps wire protocol truth sourced from @zterm/shared instead of redefining it locally', () => {
    const source = readTypesSource();

    expect(source).toContain("} from '@zterm/shared/protocol';");
    expect(source).toContain("} from '@zterm/shared/types';");
    expect(source).toContain('export type ClientMessage = BridgeClientMessage;');
    expect(source).toContain('export type ServerMessage = BridgeServerMessage;');

    expect(source).not.toContain('export interface HostConfigMessage {');
    expect(source).not.toContain('export interface BufferHeadPayload {');
    expect(source).not.toContain('export interface BufferSyncRequestPayload {');
    expect(source).not.toContain('export interface TerminalBufferPayload {');
    expect(source).not.toContain('export type ClientMessage =\n');
    expect(source).not.toContain('export type ServerMessage =\n');
  });
});
