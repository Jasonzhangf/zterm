import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import throughputContract from '../../contracts/file-transfer-throughput.json';
import {
  FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS,
  FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS,
} from './file-transfer-throughput-runtime';

const root = process.cwd();

describe('file-transfer throughput contract', () => {
  it('binds TypeScript and Android native limits to one machine-readable truth', () => {
    const buildGradle = readFileSync(
      join(root, 'native/android/app/build.gradle'),
      'utf8',
    );
    const nativeWriter = readFileSync(
      join(
        root,
        'native/android/app/src/main/java/com/zterm/android/StorageFileWriteLogic.java',
      ),
      'utf8',
    );

    expect(throughputContract.schema_version).toBe(1);
    expect(Number.isInteger(throughputContract.upload_window_chunks)).toBe(true);
    expect(throughputContract.upload_window_chunks).toBeGreaterThan(0);
    expect(Number.isInteger(throughputContract.native_write_batch_chunks)).toBe(
      true,
    );
    expect(throughputContract.native_write_batch_chunks).toBeGreaterThan(0);
    expect(FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS).toBe(
      throughputContract.upload_window_chunks,
    );
    expect(FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS).toBe(
      throughputContract.native_write_batch_chunks,
    );
    expect(buildGradle).toContain(
      "file('../../../contracts/file-transfer-throughput.json')",
    );
    expect(buildGradle).toContain(
      "buildConfigField 'int', 'FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS'",
    );
    expect(nativeWriter).toContain(
      'BuildConfig.FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS',
    );
    expect(nativeWriter).not.toMatch(/MAX_BATCH_CHUNKS\s*=\s*\d+/u);
  });
});
