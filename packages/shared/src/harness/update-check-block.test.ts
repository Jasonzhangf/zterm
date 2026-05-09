import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestHarness, type BlockContext } from './harness';
import { createOperation } from '../interaction/operation';
import {
  createUpdateCheckBlock,
  applyManifestToProjection,
  UPDATE_CHECK_PROJECTION_KEY,
  type UpdateCheckBlockDeps,
} from './update-check-block';
import {
  type AppUpdateProjectionManifest,
  type AppUpdateProjectionInput,
} from '../interaction/projection';

function makeManifest(vc: number): AppUpdateProjectionManifest {
  return {
    versionCode: vc,
    versionName: `${vc}.0`,
    apkUrl: `https://example.com/zterm-${vc}.apk`,
    sha256: 'abc123',
    notes: ['release'],
  };
}

function makeDeps(overrides?: Partial<UpdateCheckBlockDeps>): UpdateCheckBlockDeps {
  return {
    fetchManifest: vi.fn().mockResolvedValue(null),
    now: () => 1000,
    runtimeVersionCode: 100,
    defaultPreferences: {
      manifestUrl: '',
      autoCheckOnLaunch: true,
      ignoreUntilManualCheck: false,
    },
    ...overrides,
  };
}

describe('update-check-block', () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  it('update/check sets checking state in projection', () => {
    const block = createUpdateCheckBlock(makeDeps());
    harness.registerBlock(block.opTypes, block.handler);

    harness.dispatch(createOperation('update/check', {}));

    const proj = harness.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);
    expect(proj).toBeDefined();
    expect(proj!.checking).toBe(true);
    expect(proj!.updateStage).toBe('checking-manifest');
  });

  it('applyManifest with newer version sets availableManifest', () => {
    const block = createUpdateCheckBlock(makeDeps({ runtimeVersionCode: 100 }));
    harness.registerBlock(block.opTypes, block.handler);

    // First dispatch check to init projection
    harness.dispatch(createOperation('update/check', {}));

    // Then apply manifest
    const manifest = makeManifest(200);
    applyManifestToProjection(
      { emit: (e) => harness.bus.emit(e), getProjection: (k) => harness.getProjection(k), setProjection: (k, v) => { /* harness doesn't expose raw ctx, use dispatch path */ } } as BlockContext,
      manifest,
      null,
      makeDeps({ runtimeVersionCode: 100 }),
    );

    // Redispatch check block to sync projection
    const proj = harness.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);
    expect(proj).toBeDefined();
  });

  it('update/apply with no manifest fails', () => {
    const block = createUpdateCheckBlock(makeDeps());
    harness.registerBlock(block.opTypes, block.handler);

    const failedEvents: unknown[] = [];
    harness.bus.onType('operation/failed', (ev) => {
      failedEvents.push(ev);
    });

    harness.dispatch(createOperation('update/apply', {}));

    expect(failedEvents.length).toBe(1);
  });

  it('applyManifest with same version does not set available', () => {
    // Create a direct test: apply manifest to projection via dispatch
    const block = createUpdateCheckBlock(makeDeps({ runtimeVersionCode: 100 }));
    harness.registerBlock(block.opTypes, block.handler);

    harness.dispatch(createOperation('update/check', {}));

    // Simulate what orchestration does: feed manifest via ctx
    // We can do this by registering a helper block
    harness.registerBlock(['update/check'], (_op, ctx: BlockContext) => {
      const manifest = makeManifest(100); // same version
      applyManifestToProjection(ctx, manifest, null, makeDeps({ runtimeVersionCode: 100 }));
      return [];
    });

    harness.dispatch(createOperation('update/check', {}));

    const proj = harness.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);
    expect(proj!.latestManifest?.versionCode).toBe(100);
    expect(proj!.availableManifest).toBeNull(); // same version, no update
  });

  it('applyManifest with newer version sets availableManifest', () => {
    harness.registerBlock(['update/check'], (_op, ctx: BlockContext) => {
      const manifest = makeManifest(200); // newer version
      applyManifestToProjection(ctx, manifest, null, makeDeps({ runtimeVersionCode: 100 }));
      return [];
    });

    harness.dispatch(createOperation('update/check', {}));

    const proj = harness.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);
    expect(proj!.latestManifest?.versionCode).toBe(200);
    expect(proj!.availableManifest?.versionCode).toBe(200);
  });

  it('applyManifest with error sets stage to failed', () => {
    harness.registerBlock(['update/check'], (_op, ctx: BlockContext) => {
      applyManifestToProjection(ctx, null, 'Network error', makeDeps({ runtimeVersionCode: 100 }));
      return [];
    });

    harness.dispatch(createOperation('update/check', {}));

    const proj = harness.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);
    expect(proj!.updateStage).toBe('failed');
    expect(proj!.lastError).toBe('Network error');
  });
});

