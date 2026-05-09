import { describe, it, expect } from 'vitest';
import { createTestHarness } from './harness';
import { createOperation } from '../interaction/operation';
import {
  createForegroundResumeBlock,
  FOREGROUND_RESUME_PROJECTION_KEY,
  markForegroundHidden,
} from './foreground-resume-block';

describe('foreground-resume-block', () => {
  it('skips when app was not hidden', () => {
    const harness = createTestHarness();
    const block = createForegroundResumeBlock({ now: () => 1000, debounceMs: 800 });
    harness.registerBlock(block.opTypes, block.handler);

    harness.dispatch(createOperation('foreground/resume', {}));

    const failed = harness.bus.last('operation/failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.error).toContain('not-hidden');
    expect(harness.bus.last('app/foreground-resumed')).toBeUndefined();
  });

  it('resumes after marking hidden then dispatching foreground/resume', () => {
    const harness = createTestHarness();
    const block = createForegroundResumeBlock({ now: () => 1000, debounceMs: 800 });
    harness.registerBlock(block.opTypes, block.handler);

    markForegroundHidden(harness);
    harness.dispatch(createOperation('foreground/resume', {}));

    const resumed = harness.bus.last('app/foreground-resumed');
    expect(resumed).toBeDefined();
  });

  it('respects debounce between resumes', () => {
    const harness = createTestHarness();
    let time = 0;
    const block = createForegroundResumeBlock({ now: () => time, debounceMs: 100 });
    harness.registerBlock(block.opTypes, block.handler);

    markForegroundHidden(harness);
    time = 1000;
    harness.dispatch(createOperation('foreground/resume', {}));
    expect(harness.bus.last('app/foreground-resumed')).toBeDefined();

    markForegroundHidden(harness);
    time = 1050;
    harness.dispatch(createOperation('foreground/resume', {}));
    const failed = harness.bus.last('operation/failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.error).toContain('debounced');
  });

  it('allows resume after debounce window expires', () => {
    const harness = createTestHarness();
    let time = 0;
    const block = createForegroundResumeBlock({ now: () => time, debounceMs: 100 });
    harness.registerBlock(block.opTypes, block.handler);

    markForegroundHidden(harness);
    time = 1000;
    harness.dispatch(createOperation('foreground/resume', {}));
    expect(harness.bus.last('app/foreground-resumed')).toBeDefined();

    markForegroundHidden(harness);
    time = 1200;
    harness.dispatch(createOperation('foreground/resume', {}));
    expect(harness.bus.last('app/foreground-resumed')).toBeDefined();
  });

  it('stores projection state correctly', () => {
    const harness = createTestHarness();
    const block = createForegroundResumeBlock({ now: () => 1000, debounceMs: 800 });
    harness.registerBlock(block.opTypes, block.handler);

    expect(harness.getProjection(FOREGROUND_RESUME_PROJECTION_KEY)).toBeUndefined();

    markForegroundHidden(harness);
    const afterHidden = harness.getProjection<{ wasHidden: boolean }>(FOREGROUND_RESUME_PROJECTION_KEY);
    expect(afterHidden?.wasHidden).toBe(true);

    harness.dispatch(createOperation('foreground/resume', {}));
    const afterResume = harness.getProjection<{ wasHidden: boolean }>(FOREGROUND_RESUME_PROJECTION_KEY);
    expect(afterResume?.wasHidden).toBe(false);
  });

  it('ignores non-matching operations', () => {
    const harness = createTestHarness();
    const block = createForegroundResumeBlock({ now: () => 1000, debounceMs: 800 });
    harness.registerBlock(block.opTypes, block.handler);

    harness.dispatch(createOperation('update/check', {}));

    expect(harness.bus.last('app/foreground-resumed')).toBeUndefined();
    expect(harness.bus.last('operation/failed')).toBeUndefined();
  });
});
