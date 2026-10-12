/**
 * Unit tests for the fixed-timestep loop.
 *
 * The loop is tested through an injected scheduler, so these assertions are
 * about the timebase policy (fixed dt, stall clamping, catch-up cap, alpha)
 * rather than about real elapsed time. No browser, no waiting.
 */

import { describe, expect, it } from 'vitest';

import { createFixedStepLoop, type Scheduler } from './loop';

/** A scheduler whose clock only moves when the test says so. */
class FakeScheduler implements Scheduler {
  timeMs = 0;
  private nextHandle = 1;
  private readonly pending = new Map<number, (timeMs: number) => void>();

  request(callback: (timeMs: number) => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.pending.delete(handle);
  }

  now(): number {
    return this.timeMs;
  }

  /** Deliver every pending callback once, at an arbitrary timestamp. */
  deliver(timeMs: number): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const callback of due) {
      callback(timeMs);
    }
  }

  /** Advance the clock by `ms` and deliver the pending frame. */
  advance(ms: number): void {
    this.timeMs += ms;
    this.deliver(this.timeMs);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

type LoopOptions = Parameters<typeof createFixedStepLoop>[0];

/** fixedDt 10ms keeps the arithmetic exact. */
function makeLoop(overrides: Partial<LoopOptions> = {}) {
  const scheduler = new FakeScheduler();
  const updates: Array<{ dtMs: number; nowMs: number; stepIndex: number }> = [];
  const renders: Array<{ alpha: number; nowMs: number }> = [];
  const loop = createFixedStepLoop({
    fixedDtMs: 10,
    maxFrameMs: 250,
    maxUpdatesPerFrame: 5,
    fpsWindowFrames: 10,
    scheduler,
    update: (dtMs, nowMs, stepIndex) => {
      updates.push({ dtMs, nowMs, stepIndex });
    },
    render: (alpha, nowMs) => {
      renders.push({ alpha, nowMs });
    },
    ...overrides,
  });
  return { loop, scheduler, updates, renders };
}

describe('createFixedStepLoop', () => {
  it('is not running until started, and schedules exactly one frame', () => {
    const { loop, scheduler } = makeLoop();
    expect(loop.running).toBe(false);
    expect(scheduler.pendingCount).toBe(0);

    loop.start();
    expect(loop.running).toBe(true);
    expect(scheduler.pendingCount).toBe(1);

    // start() is idempotent: no duplicate scheduling.
    loop.start();
    expect(scheduler.pendingCount).toBe(1);
  });

  it('runs exactly one fixed step for one step of elapsed time', () => {
    const { loop, scheduler, updates } = makeLoop();
    loop.start();

    scheduler.advance(10);
    expect(updates).toEqual([{ dtMs: 10, nowMs: 10, stepIndex: 0 }]);

    scheduler.advance(10);
    expect(updates[1]).toEqual({ dtMs: 10, nowMs: 20, stepIndex: 1 });
  });

  it('always passes exactly fixedDtMs, never a variable delta', () => {
    const { loop, scheduler, updates } = makeLoop();
    loop.start();

    // Deliberately irregular frame times.
    for (const ms of [1, 3, 17, 4, 33, 2, 9, 21]) {
      scheduler.advance(ms);
    }

    expect(updates.length).toBeGreaterThan(0);
    expect(new Set(updates.map((u) => u.dtMs))).toEqual(new Set([10]));
  });

  it('decouples render from update: renders once per frame even with zero updates', () => {
    const { loop, scheduler, updates, renders } = makeLoop();
    loop.start();

    scheduler.advance(5);
    scheduler.advance(5);

    expect(renders).toHaveLength(2);
    expect(updates).toHaveLength(1);
    expect(renders[0]!.alpha).toBeCloseTo(0.5, 10);
    expect(renders[1]!.alpha).toBeCloseTo(0, 10);
  });

  it('reports alpha as the fraction of a step elapsed since the last update', () => {
    const { loop, scheduler, renders } = makeLoop();
    loop.start();

    scheduler.advance(15); // one step + half a step
    expect(renders[0]!.alpha).toBeCloseTo(0.5, 10);

    scheduler.advance(4); // another 0.4 of a step
    expect(renders[1]!.alpha).toBeCloseTo(0.9, 10);
  });

  it('clamps a long stall and drops the excess instead of spiralling', () => {
    const { loop, scheduler, updates, renders } = makeLoop();
    loop.start();

    scheduler.advance(5000); // the tab was backgrounded

    // Capped at maxUpdatesPerFrame, not 500.
    expect(updates).toHaveLength(5);
    // Excess past the clamp, plus the un-run backlog, is reported as dropped.
    expect(loop.stats.droppedMs).toBeCloseTo(5000 - 250 + (250 - 5 * 10), 6);
    // The backlog was discarded, so the next frame starts clean.
    expect(renders[0]!.alpha).toBe(0);
    // Frame time is reported unclamped so the HUD can show the stall.
    expect(loop.stats.lastFrameMs).toBe(5000);
  });

  it('keeps work bounded under sustained slow frames', () => {
    const { loop, scheduler } = makeLoop();
    loop.start();

    for (let i = 0; i < 50; i += 1) {
      scheduler.advance(1000); // 100 steps of backlog per frame
    }

    expect(loop.stats.droppedMs).toBeGreaterThan(0);
    expect(loop.stats.updateSteps).toBe(250); // 50 frames x 5 capped steps
  });

  it('stops scheduling and stops working after stop()', () => {
    const { loop, scheduler, renders } = makeLoop();
    loop.start();
    scheduler.advance(10);
    expect(renders).toHaveLength(1);

    loop.stop();
    expect(loop.running).toBe(false);
    expect(scheduler.pendingCount).toBe(0);

    scheduler.advance(10);
    expect(renders).toHaveLength(1);
  });

  it('can be restarted after stop()', () => {
    const { loop, scheduler, renders } = makeLoop();
    loop.start();
    scheduler.advance(10);
    loop.stop();
    loop.start();
    scheduler.advance(10);

    expect(loop.running).toBe(true);
    expect(renders).toHaveLength(2);
  });

  it('measures FPS over the configured window and needs two samples', () => {
    const { loop, scheduler } = makeLoop();
    loop.start();

    scheduler.advance(10);
    expect(loop.stats.fps).toBe(0); // one sample is not a rate

    for (let i = 0; i < 4; i += 1) {
      scheduler.advance(10);
    }
    expect(loop.stats.fps).toBeCloseTo(100, 6);
    expect(loop.stats.renderedFrames).toBe(5);
  });

  it('does not call update when less than one step has elapsed', () => {
    const { loop, scheduler, renders } = makeLoop();
    loop.start();

    scheduler.advance(9);

    expect(renders).toHaveLength(1);
    expect(loop.stats.updateSteps).toBe(0);
  });

  it('survives a non-finite timestamp without corrupting the timebase', () => {
    const { loop, scheduler, updates } = makeLoop();
    loop.start();
    scheduler.advance(10);
    const stepsBefore = loop.stats.updateSteps;

    scheduler.deliver(Number.NaN);

    expect(loop.stats.updateSteps).toBe(stepsBefore);
    expect(loop.stats.lastFrameMs).toBe(0); // falls back to scheduler.now()
    expect(Number.isFinite(loop.stats.fps)).toBe(true);
    expect(updates.every((u) => Number.isFinite(u.nowMs))).toBe(true);
  });

  it('rejects invalid timing options', () => {
    const base = {
      maxFrameMs: 250,
      maxUpdatesPerFrame: 5,
      scheduler: new FakeScheduler(),
      update: () => {},
      render: () => {},
    };
    expect(() => createFixedStepLoop({ ...base, fixedDtMs: 0 })).toThrow(RangeError);
    expect(() =>
      createFixedStepLoop({ ...base, fixedDtMs: 10, maxFrameMs: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createFixedStepLoop({ ...base, fixedDtMs: 10, maxUpdatesPerFrame: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createFixedStepLoop({ ...base, fixedDtMs: 10, maxUpdatesPerFrame: 1.5 }),
    ).toThrow(RangeError);
  });
});
