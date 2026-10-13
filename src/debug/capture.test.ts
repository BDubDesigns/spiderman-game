/**
 * Unit tests for the gesture capture (PLAN.md §11.5).
 *
 * The capture is the only route to real-device tuning data, so its two output shapes are
 * pinned: a compact text table for pasting back, and full JSON that can be replayed
 * offline. Losing landmarks from the JSON would silently make it unreplayable, and losing
 * the thresholds would make it uncomparable against a later build.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE, JOINT } from '../config';
import { HandFrameCapture, type CapturedFrame } from './capture';

function makeFrame(overrides: Partial<CapturedFrame> = {}): Omit<CapturedFrame, 'label'> {
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

describe('HandFrameCapture', () => {
  it('starts empty and reports its capacity', () => {
    const capture = new HandFrameCapture(10);
    expect(capture.size).toBe(0);
    expect(capture.capacityFrames).toBe(10);
    expect(capture.all).toEqual([]);
  });

  it('keeps the newest frames and drops the oldest once full', () => {
    const capture = new HandFrameCapture(3);
    for (let i = 1; i <= 5; i += 1) capture.record(makeFrame({ tMs: i * 100 }));

    expect(capture.size).toBe(3);
    expect(capture.all.map((frame) => frame.tMs)).toEqual([300, 400, 500]);
  });

  it('clear() empties the buffer', () => {
    const capture = new HandFrameCapture(3);
    capture.record(makeFrame());
    capture.clear();
    expect(capture.size).toBe(0);
  });

  it('stamps the current label and shares the caller\'s landmark array', () => {
    // The label is stamped by the buffer; landmarks are shared, so `main.ts` is responsible
    // for copying them. This test documents that contract rather than hiding it.
    const capture = new HandFrameCapture(1);
    capture.setLabel('palm-gesture');
    const frame = makeFrame();
    capture.record(frame);

    const stored = capture.all[0]!;
    expect(stored.label).toBe('palm-gesture');
    expect(stored.landmarks).toBe(frame.landmarks);
    expect(stored.tMs).toBe(frame.tMs);
  });

  it('starts unlabeled, so unlabelled runs cannot be mistaken for ground truth', () => {
    const capture = new HandFrameCapture(1);
    expect(capture.currentLabel).toBe('unlabeled');
    capture.record(makeFrame());
    expect(capture.all[0]!.label).toBe('unlabeled');
  });

  it('applies a label only to frames captured after it is set', () => {
    // A mis-tap must not relabel data the player was not doing the new thing during.
    const capture = new HandFrameCapture(10);
    capture.setLabel('open');
    capture.record(makeFrame({ tMs: 1 }));
    capture.setLabel('fist');
    capture.record(makeFrame({ tMs: 2 }));

    expect(capture.all.map((f) => f.label)).toEqual(['open', 'fist']);
  });
});

describe('HandFrameCapture.toTextSummary', () => {
  it('is compact and pasteable, with one line per observation plus a header', () => {
    const capture = new HandFrameCapture(10);
    capture.record(makeFrame({ tMs: 1600 }));
    const lines = capture.toTextSummary().split('\n');

    expect(lines[0]).toContain('observations 1 of 10');
    // No span line: a lone observation has no interval to measure.
    expect(lines[1]).toContain('dist mid/ring/idx/pky');
    // The four distance ratios and both verdicts, which is what decides the next step.
    const row = lines[2]!;
    expect(row).toContain('0.77/0.79/1.40/1.30');
    expect(row).toContain('n/Y');
    // Then the per-label margins block, which is what tuning actually reads.
    expect(lines.join('\n')).toContain('per-label margins');
    expect(lines.join('\n')).toContain('unlabeled');
  });

  it('reports per-label margins, which is the data a threshold change needs', () => {
    const capture = new HandFrameCapture(20);
    capture.setLabel('open');
    capture.record(
      makeFrame({
        angle: { ...makeFrame().angle, pip: { middle: 178, ring: 176, index: 180, pinky: 179 } },
        verdict: { distanceGesture: false, distanceScore: 0, angleGesture: false, angleScore: 0, method: 'angle' },
      }),
    );
    capture.setLabel('palm-gesture');
    capture.record(makeFrame({ verdict: { distanceGesture: false, distanceScore: 0, angleGesture: true, angleScore: 1, method: 'angle' } }));

    const text = capture.toTextSummary();
    expect(text).toContain('palm-gesture');
    expect(text).toContain('n=  1');
    // The gesturing label reports its one fire out of one.
    expect(text).toContain('angle-fired 1/1');
    expect(text).toContain('angle-fired 0/1');
  });

  it('states the observation rate, because that is what distinguishes observations from renders', () => {
    // The device capture that exposed the timing bug reported 150 "frames" over 4.75 s —
    // ~31 Hz of render callbacks, not the ~5 Hz detection rate. This line makes that
    // visible at a glance instead of requiring the timestamps to be checked by hand.
    const capture = new HandFrameCapture(200);
    for (let i = 0; i < 10; i += 1) capture.record(makeFrame({ tMs: i * 213 }));

    expect(capture.toTextSummary()).toContain('mean 4.7 Hz (expect ~5, NOT ~60)');
  });

  it('omits the rate for a single observation, which has no span', () => {
    const capture = new HandFrameCapture(10);
    capture.record(makeFrame());
    expect(capture.toTextSummary()).not.toContain('mean');
  });

  it('renders a missing PIP angle as -- rather than 0', () => {
    // A `null` angle means "unmeasurable", and printing 0 would read as "perfectly
    // straight", which is the opposite of unknown.
    const capture = new HandFrameCapture(5);
    capture.record(
      makeFrame({
        angle: {
          ...makeFrame().angle,
          pip: { middle: null, ring: 82.4, index: 180, pinky: 180 },
        },
      }),
    );
    expect(capture.toTextSummary()).toContain('  --/82.40/180.00/180.00');
  });

  it('reports the capacity so a full buffer is not mistaken for a short sample', () => {
    const capture = new HandFrameCapture(150);
    capture.record(makeFrame());
    expect(capture.toTextSummary().split('\n')[0]).toBe(
      'observations 1 of 150 (one line per observed hand frame)',
    );
  });
});

describe('HandFrameCapture.toJson', () => {
  const meta = { url: 'http://127.0.0.1:5173/?source=camera', capturedAt: '2026-10-13 09:00:00' };

  it('carries the raw landmarks, so a frame can be replayed offline', () => {
    const capture = new HandFrameCapture(5);
    capture.record(makeFrame());
    const parsed = JSON.parse(capture.toJson(meta)) as {
      frames: Array<{ landmarks: unknown[] }>;
    };

    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]!.landmarks).toHaveLength(21);
  });

  it('carries both thresholds blocks, so a capture can be compared against another build', () => {
    const capture = new HandFrameCapture(5);
    const parsed = JSON.parse(capture.toJson(meta)) as {
      thresholds: {
        distance: Record<string, number>;
        joint: Record<string, number>;
      };
    };

    expect(parsed.thresholds.distance['foldEnter']).toBe(GESTURE.foldEnter);
    expect(parsed.thresholds.joint['curlStrongDeg']).toBe(JOINT.curlStrongDeg);
    expect(Object.keys(parsed.thresholds.joint)).toHaveLength(9);
  });

  it('records the url, time and schema, so a capture is attributable', () => {
    const capture = new HandFrameCapture(5);
    const parsed = JSON.parse(capture.toJson(meta)) as Record<string, unknown>;

    expect(parsed['schema']).toBe('web-slinger-gesture-capture/1');
    expect(parsed['url']).toBe(meta.url);
    expect(parsed['capturedAt']).toBe(meta.capturedAt);
  });

  it('explains its own columns, because a raw dump is not self-describing', () => {
    const capture = new HandFrameCapture(5);
    const parsed = JSON.parse(capture.toJson(meta)) as { note: string };
    expect(parsed.note).toContain('x by image width');
  });

  it('carries the label into the JSON, so offline analysis can group by intent', () => {
    const capture = new HandFrameCapture(5);
    capture.setLabel('wrist-away-gesture');
    capture.record(makeFrame());
    const parsed = JSON.parse(capture.toJson(meta)) as {
      frames: Array<{ label: string }>;
    };
    expect(parsed.frames[0]!.label).toBe('wrist-away-gesture');
  });

  it('produces valid JSON for an empty capture', () => {
    const parsed = JSON.parse(new HandFrameCapture(5).toJson(meta)) as { frames: unknown[] };
    expect(parsed.frames).toEqual([]);
  });
});
