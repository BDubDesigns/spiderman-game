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

function makeFrame(overrides: Partial<CapturedFrame> = {}): CapturedFrame {
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

  it('copies nothing implicitly: the recorded frame object is stored as given', () => {
    // The caller is responsible for deep-copying landmarks, which main.ts does. This
    // test documents that contract rather than hiding it.
    const capture = new HandFrameCapture(1);
    const frame = makeFrame();
    capture.record(frame);
    expect(capture.all[0]).toBe(frame);
  });
});

describe('HandFrameCapture.toTextSummary', () => {
  it('is compact and pasteable, with one line per frame plus a header', () => {
    const capture = new HandFrameCapture(10);
    capture.record(makeFrame({ tMs: 1600 }));
    const lines = capture.toTextSummary().split('\n');

    expect(lines[0]).toContain('frames 1 of 10');
    expect(lines[1]).toContain('dist mid/ring/idx/pky');
    expect(lines).toHaveLength(3);
    // The four distance ratios and both verdicts, which is what decides the next step.
    const row = lines[2]!;
    expect(row).toContain('0.77/0.79/1.40/1.30');
    expect(row).toContain('n/Y');
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
    expect(capture.toTextSummary().split('\n')[0]).toBe('frames 1 of 150 (observed hands only)');
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

  it('produces valid JSON for an empty capture', () => {
    const parsed = JSON.parse(new HandFrameCapture(5).toJson(meta)) as { frames: unknown[] };
    expect(parsed.frames).toEqual([]);
  });
});
