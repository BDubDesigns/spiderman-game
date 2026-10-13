/**
 * Unit tests for adaptive inference scheduling (PLAN.md §7.1).
 *
 * The policy under test is the whole point of §7.1: inference frequency is not a
 * target, render FPS is. So these assert the three bounds — the rate cap, the
 * budget, and the floor — and that the measured numbers are what drive them.
 */

import { describe, expect, it } from 'vitest';

import { InferenceScheduler, type InferenceSchedulerOptions } from './inferenceScheduler';

function makeScheduler(overrides: Partial<InferenceSchedulerOptions> = {}) {
  return new InferenceScheduler({
    minInferenceHz: 5,
    maxInferenceHz: 30,
    inferenceBudgetFraction: 0.5,
    costEmaAlpha: 0.3,
    initialCostEstimateMs: 45,
    // 30 fps budget, so `affordable` is 16.67 ms at a 0.5 fraction.
    initialFrameBudgetMs: 1000 / 30,
    ...overrides,
  });
}

describe('InferenceScheduler', () => {
  it('runs on the very first opportunity, having nothing measured yet', () => {
    const scheduler = makeScheduler();
    expect(scheduler.shouldRun(0)).toBe(true);
  });

  it('enforces maxInferenceHz even when inference is cheap', () => {
    const scheduler = makeScheduler();
    // Cheap measured calls first, so the budget is not what is being tested here.
    for (let i = 0; i < 6; i += 1) scheduler.recordRun(1, i * 100);
    expect(scheduler.stats.predictedCostMs).toBeLessThan(16.67);

    // The 30 Hz ceiling is a 33.33 ms minimum interval, measured from the last run.
    expect(scheduler.shouldRun(510)).toBe(false);
    expect(scheduler.stats.skipsRateCap).toBe(1);
    expect(scheduler.shouldRun(534)).toBe(true);
  });

  it('skips when the predicted cost will not fit the frame budget', () => {
    const scheduler = makeScheduler();
    // Seed a measured cost well above half of a 33.3 ms frame.
    scheduler.recordRun(40, 0);
    scheduler.recordRun(40, 100);

    expect(scheduler.stats.predictedCostMs).toBeGreaterThan(16.67);
    expect(scheduler.shouldRun(150)).toBe(false);
    expect(scheduler.stats.skipsOverBudget).toBe(1);
  });

  it('still runs at the minInferenceHz floor when inference is unaffordable', () => {
    const scheduler = makeScheduler({ minInferenceHz: 5 });
    scheduler.recordRun(40, 0);
    scheduler.recordRun(40, 100);

    // The floor interval is measured from the last run (100 ms), so 200 ms after
    // that the floor overrides the budget.
    expect(scheduler.shouldRun(299)).toBe(false);
    expect(scheduler.shouldRun(300)).toBe(true);
    expect(scheduler.stats.forcedRuns).toBe(1);
  });

  it('becomes affordable again once measurement says the call got cheaper', () => {
    const scheduler = makeScheduler();
    scheduler.recordRun(45, 0);
    expect(scheduler.shouldRun(100)).toBe(false);

    // Four cheap calls drag the moving average under the 16.67 ms budget.
    for (let i = 1; i <= 4; i += 1) scheduler.recordRun(5, i * 100);
    expect(scheduler.stats.predictedCostMs).toBeLessThan(16.67);

    expect(scheduler.shouldRun(600)).toBe(true);
  });

  it('measures achieved inference Hz from real run timestamps', () => {
    const scheduler = makeScheduler();
    for (let i = 0; i < 5; i += 1) scheduler.recordRun(2, i * 50);

    // Five runs 50 ms apart is a 20 Hz achieved rate.
    expect(scheduler.stats.inferenceHz).toBeCloseTo(20, 6);
    expect(scheduler.stats.runs).toBe(5);
  });

  it('needs two runs before it will report a rate', () => {
    const scheduler = makeScheduler();
    scheduler.recordRun(2, 0);
    expect(scheduler.stats.inferenceHz).toBe(0);
  });

  it('tracks the frame budget from observed frame intervals, not a constant', () => {
    const scheduler = makeScheduler({ initialFrameBudgetMs: 1000 / 30 });
    const initial = scheduler.stats.frameBudgetMs;

    // A 60 fps device: the budget should move toward 16.7 ms.
    let now = 0;
    for (let i = 0; i < 20; i += 1) {
      now += 1000 / 60;
      scheduler.observeFrame(now);
    }

    expect(scheduler.stats.frameBudgetMs).toBeLessThan(initial);
    expect(scheduler.stats.frameBudgetMs).toBeGreaterThan(16);
    expect(scheduler.stats.frameBudgetMs).toBeLessThan(18);
  });

  it('ignores a zero-length or backwards frame interval rather than poisoning the average', () => {
    const scheduler = makeScheduler();
    scheduler.observeFrame(100);
    const before = scheduler.stats.frameBudgetMs;

    scheduler.observeFrame(100); // same timestamp
    scheduler.observeFrame(50); // backwards

    expect(scheduler.stats.frameBudgetMs).toBe(before);
  });

  it('records the last measured cost exactly, and the prediction as a moving average', () => {
    const scheduler = makeScheduler();
    scheduler.recordRun(20, 0);
    expect(scheduler.stats.lastCostMs).toBe(20);
    // 45 * 0.7 + 20 * 0.3
    expect(scheduler.stats.predictedCostMs).toBeCloseTo(37.5, 6);
  });

  it('treats a non-finite or negative duration as zero rather than propagating NaN', () => {
    const scheduler = makeScheduler();
    scheduler.recordRun(Number.NaN, 0);
    scheduler.recordRun(-5, 10);

    expect(Number.isFinite(scheduler.stats.predictedCostMs)).toBe(true);
    expect(Number.isFinite(scheduler.stats.inferenceHz)).toBe(true);
  });

  it('resets measurement history but keeps configuration', () => {
    const scheduler = makeScheduler();
    scheduler.recordRun(40, 0);
    scheduler.recordRun(40, 100);
    scheduler.reset();

    expect(scheduler.stats.runs).toBe(0);
    expect(scheduler.stats.inferenceHz).toBe(0);
    // Nothing measured, so the first opportunity runs again.
    expect(scheduler.shouldRun(1000)).toBe(true);
  });

  it('rejects incoherent configuration', () => {
    expect(() => makeScheduler({ minInferenceHz: 0 })).toThrow(RangeError);
    expect(() => makeScheduler({ maxInferenceHz: 0 })).toThrow(RangeError);
    expect(() => makeScheduler({ minInferenceHz: 30, maxInferenceHz: 5 })).toThrow(
      RangeError,
    );
  });
});
