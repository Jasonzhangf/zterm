import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

const capturePath = 'src/server/terminal-mirror-capture.ts';

describe('daemon.mirror_writer ownership', () => {
  it('owns the mirror capture and snapshot commit path exclusively', () => {
    const moduleRegistry = JSON.parse(
      read('docs/module-registry.json'),
    ) as {
      modules: Array<{
        module_id: string;
        owned_paths?: string[];
      }>;
    };
    const mirrorWriter = moduleRegistry.modules.find(
      (candidate) => candidate.module_id === 'daemon.mirror_writer',
    );
    const mirrorStore = moduleRegistry.modules.find(
      (candidate) => candidate.module_id === 'daemon.mirror_store',
    );

    expect(mirrorWriter).toBeTruthy();
    expect(mirrorWriter?.owned_paths).toContain(capturePath);
    expect(mirrorStore?.owned_paths).not.toContain(capturePath);
  });

  it('registers the mirror writer feature with the same physical owner', () => {
    const featureRegistry = JSON.parse(
      read('docs/feature-registry.json'),
    ) as {
      features: Array<{
        feature_id: string;
        owners: string[];
      }>;
    };
    const feature = featureRegistry.features.find(
      (candidate) => candidate.feature_id === 'daemon.mirror_writer',
    );

    expect(feature).toBeTruthy();
    expect(feature?.owners).toContain(capturePath);
  });

  it('declares the real mirror writer import edges', () => {
    const edgeRegistry = JSON.parse(read('docs/edge-registry.json')) as {
      import_edges: Array<{
        from_module: string;
        to_module: string;
      }>;
    };
    const declared = new Set(
      edgeRegistry.import_edges.map((edge) => `${edge.from_module}->${edge.to_module}`),
    );

    expect(declared.has('daemon.mirror_writer->daemon.source_adapter')).toBe(true);
    expect(declared.has('daemon.mirror_writer->daemon.runtime')).toBe(true);
    expect(declared.has('daemon.runtime_entry->daemon.mirror_writer')).toBe(true);
  });

  it('keeps snapshot writes inside the writer and out of subscriber/renderer truth', () => {
    const captureSource = read(capturePath);
    const runtimeSource = read('src/server/terminal-mirror-runtime.ts');

    expect(captureSource).toContain('mirror.rows = snapshot.rows');
    expect(captureSource).toContain('mirror.bufferLines = snapshot.bufferLines');
    expect(captureSource).not.toMatch(
      /from ['"]\.\/(terminal-mirror-runtime|daemon-buffer-publisher-runtime|terminal-message-runtime|terminal-transport-runtime)['"]/,
    );
    expect(captureSource).not.toContain('viewport');
    expect(runtimeSource).toContain('deps.captureMirrorAuthoritativeBufferFromTmux(mirror)');
  });
});
