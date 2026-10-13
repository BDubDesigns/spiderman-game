/**
 * Unit tests for the gesture capture (PLAN.md §11.5).
 *
 * The capture is the only route to real-device tuning data, so both output shapes are pinned,
 * along with the property that matters most after the second-pass review: **the dataset is a set
 * of deliberate takes, not a rolling window.**
 *
 * The first version had a rolling buffer and a button that only re-rendered it. At the measured
 * ~4.7 Hz, 150 observations is about 32 seconds, so a real four-minute labelled session evicted
 * its own early takes before the download. These tests exist so that cannot come back silently.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE, JOINT } from '../config';
import { HandFrameCapture, type CaptureTake, type CapturedFrame } from './capture';

function capture(rollingCapacity = 150, sessionFrameCapacity = 2000): HandFrameCapture {
  return new HandFrameCapture({ rollingCapacity, sessionFrameCapacity });
}

function makeFrame(overrides: Partial<Omit<CapturedFrame, 'label'>> = {}): Omit<CapturedFrame, 'label'> {
  return {
    tMs: 1000,
    identity: 'right',
    handednessLabel: 'Right',
    handednessScore: 0.95,
    landmarks: Array.from({ length: 21 }, (_, i) => ({ x: i / 100, y: i / 50 })),
    distance: { span: 1, middleToPalm: 0.77, ringToPalm: 0.79, indexExt: 1.4, pinkyExt: 1.3 },
    angle: {
      pip: { middle: 82.4, ring: 82.4, index: 180, pinky: 180 },
      chord: { middle: 0.74, ring: 0.56, index: 1, pinky: 1 },
      chain: { middle: 1.4, ring: 1.4, index: 0.95, pinky: 0.9 },
      reliable: { middle: true, ring: true, index: true, pinky: true },
      basis: { middle: 'angle', ring: 'angle', index: 'angle', pinky: 'angle' },
    },
    verdict: {
      distanceGesture: false,
      distanceScore: 0,
      angleGesture: true,
      angleScore: 1,
      method: 'distance',
    },
    ...overrides,
  };
}

/** Record a run of observations at `hz` starting at `startMs`. */
function recordRun(
  store: HandFrameCapture,
  startMs: number,
  count: number,
  hz = 4.7,
  overrides: Partial<Omit<CapturedFrame, 'label'>> = {},
): void {
  const step = 1000 / hz;
  for (let i = 0; i < count; i += 1) {
    store.record(makeFrame({ tMs: startMs + i * step, ...overrides }));
  }
}

describe('rolling buffer (diagnostic)', () => {
  it('starts empty', () => {
    const store = capture();
    expect(store.size).toBe(0);
    expect(store.takeCount).toBe(0);
    expect(store.sessionFrames).toBe(0);
    expect(store.capacityFrames).toBe(150);
  });

  it('keeps the newest observations and drops the oldest', () => {
    const store = capture(3);
    recordRun(store, 0, 5, 1000);
    expect(store.size).toBe(3);
    expect(store.all.map((frame) => frame.tMs)).toEqual([2, 3, 4]);
  });

  it('does not retain data as a tuning dataset', () => {
    // The rolling buffer is explicitly *not* the dataset: 150 observations is ~32 s at 4.7 Hz.
    const store = capture(150);
    recordRun(store, 0, 400);
    expect(store.size).toBe(150);
    expect(store.sessionFrames).toBe(0);
  });
});

describe('saving a take', () => {
  it('saves the trailing window and returns it', () => {
    const store = capture();
    store.setLabel('palm-gesture');
    recordRun(store, 0, 10); // ~213 ms apart

    const saved = store.take(2000, 1500);
    expect(saved).not.toBeNull();
    expect(saved!.label).toBe('palm-gesture');
    expect(saved!.id).toBe(1);
    expect(saved!.windowMs).toBe(1500);
    // Only observations inside the window, i.e. tMs > 500.
    expect(saved!.frames.length).toBeGreaterThan(0);
    expect(saved!.frames.every((frame) => frame.tMs > 500)).toBe(true);
  });

  it('stamps the label onto the saved frames, not the rolling ones', () => {
    const store = capture();
    store.setLabel('open');
    recordRun(store, 0, 5);
    store.setLabel('fist');
    const saved = store.take(1000, 1500);

    expect(saved!.label).toBe('fist');
    expect(saved!.frames.every((frame) => frame.label === 'fist')).toBe(true);
  });

  it('returns null when there is nothing fresh, rather than saving an empty take', () => {
    const store = capture();
    recordRun(store, 0, 5);
    expect(store.take(100_000, 1500)).toBeNull();
    expect(store.takeCount).toBe(0);
  });

  it('returns null before any observation has arrived', () => {
    expect(capture().take(1000, 1500)).toBeNull();
  });

  it('does not duplicate observations across two takes', () => {
    // A double-tap must not save the same evidence twice: it would double-weight those frames in
    // any per-label statistic derived from the dataset.
    const store = capture();
    recordRun(store, 0, 10);
    const first = store.take(2000, 1500)!;
    const second = store.take(2000, 1500);

    expect(second).toBeNull();
    const firstTimes = new Set(first.frames.map((frame) => frame.tMs));
    expect(firstTimes.size).toBe(first.frames.length);
  });

  it('labels each take independently, so one session can cover several poses', () => {
    const store = capture();
    store.setLabel('open');
    recordRun(store, 0, 6);
    store.take(1200, 1500);

    store.setLabel('palm-gesture');
    recordRun(store, 2000, 6);
    store.take(3200, 1500);

    expect(store.takeCount).toBe(2);
    expect(store.takes.map((take) => take.label)).toEqual(['open', 'palm-gesture']);
    expect(store.labelCounts()).toEqual({ open: 1, 'palm-gesture': 1 });
  });

  it('clear() empties the takes as well as the rolling buffer', () => {
    const store = capture();
    recordRun(store, 0, 6);
    store.take(1200, 1500);
    store.clear();

    expect(store.size).toBe(0);
    expect(store.takeCount).toBe(0);
    expect(store.sessionFrames).toBe(0);
    // Claims are released too, so a fresh run starts clean.
    recordRun(store, 0, 6);
    expect(store.take(1200, 1500)).not.toBeNull();
  });
});

describe('the dataset survives a real session — the second-pass review finding', () => {
  /**
   * A four-minute labelled run: five poses, several repetitions, moving between them. The rolling
   * buffer must evict freely (it is diagnostic), and **no** saved take may be lost.
   */
  it('keeps every take across a simulated 4-minute session with gaps', () => {
    const store = capture(150, 2000);
    const labels = ['open', 'palm-gesture', 'wrist-away-gesture', 'fist', 'relaxed'] as const;

    let clock = 0;
    const expected: string[] = [];
    // Five poses, four repetitions each, at a realistic 12 s per pose: about three seconds to
    // settle into the pose and hold it, then nine seconds to move and reposition. Twenty takes
    // over four minutes is the workflow the capture instructions describe.
    for (let repetition = 0; repetition < 4; repetition += 1) {
      for (const label of labels) {
        store.setLabel(label);
        // Settle into the pose for comfortably longer than the take window, so the take covers
        // the held pose rather than the movement that preceded it.
        recordRun(store, clock, 15);
        clock += 3000;
        expect(store.take(clock, 1500)).not.toBeNull();
        expected.push(label);
        // Move to the next pose, with a gap in which nothing is saved.
        recordRun(store, clock, 42);
        clock += 9000;
      }
    }

    expect(clock).toBeGreaterThanOrEqual(4 * 60 * 1000); // genuinely a four-minute session
    expect(store.takeCount).toBe(20);
    expect(store.takes.map((take) => take.label)).toEqual(expected);
    // All five labels are represented, several times over.
    expect(store.labelCounts()).toEqual({
      open: 4,
      'palm-gesture': 4,
      'wrist-away-gesture': 4,
      fist: 4,
      relaxed: 4,
    });
    // The rolling buffer cycled many times over during the session, so eviction definitely
    // happened — proving the takes did not survive by luck.
    expect(store.size).toBe(150);
  });

  it('would have lost most of that session under a rolling-only buffer', () => {
    // Guards the guard: this is the failure the take flow exists to prevent. A buffer that is
    // never saved from retains only the last ~150 observations no matter how long the run is.
    const rollingOnly = capture(150);
    recordRun(rollingOnly, 0, 900);
    expect(rollingOnly.size).toBe(150);
    expect(rollingOnly.sessionFrames).toBe(0);
  });

  it('does not silently label transition frames as a stable pose', () => {
    // The player moves between poses. Provided the pose is held for at least the take window
    // before tapping, no saved frame can carry a transition — this is the property that makes the
    // labels ground truth. (The window reaches back 1.5 s from the tap, so holding for less than
    // that can reach into the movement; the panel text tells the player to hold ~a second.)
    const store = capture();
    const MOVING = { middleToPalm: 9.99, ringToPalm: 9.99 };
    const movingPose = { span: 1, ...MOVING, indexExt: 1.4, pinkyExt: 1.3 };

    store.setLabel('open');
    recordRun(store, 0, 6, 4.7, { distance: movingPose }); // moving into the pose
    recordRun(store, 1400, 15); // settled and held for ~3 s
    store.take(2800, 1500);

    store.setLabel('fist');
    recordRun(store, 2800, 6, 4.7, { distance: movingPose }); // moving again
    recordRun(store, 4200, 15);
    store.take(5600, 1500);

    const savedFrames = store.takes.flatMap((take) => take.frames);
    expect(savedFrames.length).toBeGreaterThan(0);
    expect(savedFrames.every((frame) => frame.distance.middleToPalm !== MOVING.middleToPalm)).toBe(
      true,
    );
    // And every saved frame precedes or follows nothing but its own take's window.
    for (const take of store.takes) {
      expect(take.frames.every((frame) => frame.tMs > take.takenAtMs - 1500)).toBe(true);
    }
  });
});

describe('session capacity is a memory bound, not a policy', () => {
  it('never evicts during a realistic session', () => {
    // 20 takes of ~6 observations is ~120 frames, far below the bound.
    const store = capture(150, 2000);
    let clock = 0;
    for (let i = 0; i < 20; i += 1) {
      recordRun(store, clock, 6);
      clock += 1300;
      store.take(clock, 1500);
    }
    expect(store.takeCount).toBe(20);
  });

  it('still bounds memory if the set grows unreasonably', () => {
    const store = capture(150, 10);
    let clock = 0;
    for (let i = 0; i < 10; i += 1) {
      recordRun(store, clock, 6);
      clock += 1300;
      store.take(clock, 1500);
    }
    expect(store.sessionFrames).toBeLessThanOrEqual(10);
    expect(store.takeCount).toBeGreaterThan(0);
  });
});

describe('toTextSummary', () => {
  it('says what to do when no takes exist yet', () => {
    const text = capture().toTextSummary();
    expect(text).toContain('takes 0');
    expect(text).toContain('No takes saved yet');
  });

  it('lists each take and the per-label margins for tuning', () => {
    const store = capture();
    store.setLabel('palm-gesture');
    recordRun(store, 0, 6);
    store.take(1200, 1500);

    const text = store.toTextSummary();
    expect(text).toContain('takes 1');
    expect(text).toContain('labels: palm-gesture x1');
    expect(text).toContain('take 1  palm-gesture');
    expect(text).toContain('per-label margins');
    expect(text).toContain('PIP mid 82..82');
    expect(text).toContain('angle-fired 6/6');
  });

  it('reports the observation rate, which distinguishes observations from render callbacks', () => {
    const store = capture();
    recordRun(store, 0, 10);
    expect(store.toTextSummary()).toContain('mean 4.7 Hz (expect ~5, NOT ~60)');
  });

  it('renders a missing PIP angle as -- rather than 0', () => {
    const store = capture();
    store.setLabel('open');
    store.record(
      makeFrame({
        angle: { ...makeFrame().angle, pip: { middle: null, ring: 82.4, index: 180, pinky: 180 } },
      }),
    );
    store.take(1000, 1500);

    // An unmeasurable angle must not read as "perfectly straight", which is the opposite of
    // unknown.
    expect(store.toTextSummary()).toContain('PIP mid --');
  });
});

describe('toJson', () => {
  const meta = { url: 'http://127.0.0.1:5173/?source=camera', capturedAt: '2026-10-13 09:00:00' };

  it('carries the takes, each with its label and raw landmarks', () => {
    const store = capture();
    store.setLabel('wrist-away-gesture');
    recordRun(store, 0, 6);
    store.take(1200, 1500);

    const parsed = JSON.parse(store.toJson(meta)) as {
      takes: CaptureTake[];
      takeCount: number;
      sessionFrames: number;
    };
    expect(parsed.takeCount).toBe(1);
    expect(parsed.takes[0]!.label).toBe('wrist-away-gesture');
    expect(parsed.takes[0]!.frames[0]!.landmarks).toHaveLength(21);
    expect(parsed.sessionFrames).toBe(parsed.takes[0]!.frames.length);
  });

  it('carries both thresholds blocks, so a capture can be compared against another build', () => {
    const parsed = JSON.parse(capture().toJson(meta)) as {
      thresholds: { distance: Record<string, number>; joint: Record<string, number> };
    };
    expect(parsed.thresholds.distance['foldEnter']).toBe(GESTURE.foldEnter);
    expect(parsed.thresholds.joint['curlStrongDeg']).toBe(JOINT.curlStrongDeg);
    expect(Object.keys(parsed.thresholds.joint)).toHaveLength(9);
  });

  it('records the schema, url, time and an explanation of its own columns', () => {
    const parsed = JSON.parse(capture().toJson(meta)) as Record<string, unknown>;
    expect(parsed['schema']).toBe('web-slinger-gesture-capture/2');
    expect(parsed['url']).toBe(meta.url);
    expect(parsed['capturedAt']).toBe(meta.capturedAt);
    expect(String(parsed['note'])).toContain('deliberate snapshot');
  });

  it('produces valid JSON for an empty capture', () => {
    const parsed = JSON.parse(capture().toJson(meta)) as { takes: unknown[] };
    expect(parsed.takes).toEqual([]);
  });
});
