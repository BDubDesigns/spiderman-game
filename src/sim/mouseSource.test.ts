/**
 * Unit tests for the interactive hand simulator (PLAN.md §13 M0, §21.5).
 *
 * The simulator is a permanent fixture (PLAN.md §16.3), so it is tested as a
 * real subsystem rather than as a demo: geometry, aspect correction, mirroring,
 * the clamp, and the frame-source lifecycle.
 *
 * These tests deliberately do NOT classify a gesture. Gesture classification is
 * M2 (PLAN.md §13) and implementing it here would be scope creep. Where the
 * simulator's *pose* matters, the assertions are geometric ("the fingertips came
 * close to the palm") rather than a reimplementation of §11.
 */

import { describe, expect, it } from 'vitest';

import {
  LANDMARK_COUNT,
  Landmark,
  type NormalizedLandmark,
  type RawHandFrame,
} from '../tracking/landmarkTypes';
import {
  buildSyntheticHand,
  clampPalmToSource,
  handTemplateAtCurl,
  MouseSource,
} from './mouseSource';

const PALM_INDEX = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

type Point = { x: number; y: number };

function toPx(lm: NormalizedLandmark, w: number, h: number): Point {
  return { x: lm.x * w, y: lm.y * h };
}

function distancePx(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function palmPx(landmarks: NormalizedLandmark[], w: number, h: number): Point {
  let x = 0;
  let y = 0;
  for (const index of PALM_INDEX) {
    const p = toPx(landmarks[index]!, w, h);
    x += p.x;
    y += p.y;
  }
  return { x: x / PALM_INDEX.length, y: y / PALM_INDEX.length };
}

function build(
  overrides: Partial<Parameters<typeof buildSyntheticHand>[0]> = {},
): RawHandFrame {
  return buildSyntheticHand({
    palm: { x: 0.5, y: 0.5 },
    sourceWidthPx: 640,
    sourceHeightPx: 480,
    spanPx: 120,
    curl: 0,
    rollRad: 0,
    handedness: 'Right',
    handednessScore: 0.97,
    ...overrides,
  });
}

describe('buildSyntheticHand', () => {
  it('emits exactly 21 finite landmarks with a handedness classification', () => {
    const hand = build();
    expect(hand.landmarks).toHaveLength(LANDMARK_COUNT);
    for (const lm of hand.landmarks) {
      expect(Number.isFinite(lm.x)).toBe(true);
      expect(Number.isFinite(lm.y)).toBe(true);
    }
    expect(hand.handedness).toEqual({ label: 'Right', score: 0.97 });
  });

  it('reports no per-hand confidence fields, because the model has none (§5.1)', () => {
    const hand = build();
    const keys = Object.keys(hand).sort();
    expect(keys).toEqual(['handedness', 'landmarks']);
    expect(Object.keys(hand.handedness).sort()).toEqual(['label', 'score']);
  });

  it('places the palm centroid exactly on the requested anchor', () => {
    for (const [w, h] of [
      [640, 480],
      [480, 640],
      [1000, 100],
    ] as const) {
      for (const palm of [
        { x: 0.5, y: 0.5 },
        { x: 0.25, y: 0.75 },
        { x: 0.9, y: 0.1 },
      ]) {
        const hand = build({ palm, sourceWidthPx: w, sourceHeightPx: h });
        const centroid = palmPx(hand.landmarks, w, h);
        expect(centroid.x).toBeCloseTo(palm.x * w, 6);
        expect(centroid.y).toBeCloseTo(palm.y * h, 6);
      }
    }
  });

  it('keeps the hand span isotropic in pixels on non-square sources', () => {
    // The whole point of normalizing at the end: a round hand must not come out
    // sheared just because normalized x and y have different pixel scales.
    for (const [w, h] of [
      [640, 480],
      [480, 640],
      [1920, 1080],
      [320, 1200],
    ] as const) {
      for (const spanPx of [40, 120, 260]) {
        const hand = build({ sourceWidthPx: w, sourceHeightPx: h, spanPx });
        const wrist = toPx(hand.landmarks[Landmark.WRIST]!, w, h);
        const middleMcp = toPx(hand.landmarks[Landmark.MIDDLE_MCP]!, w, h);
        expect(distancePx(wrist, middleMcp)).toBeCloseTo(spanPx, 4);
      }
    }
  });

  it('scales with the span, so adult and child hand sizes stay plausible', () => {
    const small = build({ spanPx: 60 });
    const large = build({ spanPx: 180 });
    const spanOf = (hand: RawHandFrame) =>
      distancePx(
        toPx(hand.landmarks[Landmark.WRIST]!, 640, 480),
        toPx(hand.landmarks[Landmark.MIDDLE_MCP]!, 640, 480),
      );
    expect(spanOf(small)).toBeCloseTo(60, 4);
    expect(spanOf(large)).toBeCloseTo(180, 4);
  });

  it('renders the left hand as a true reflection of the right about the anchor', () => {
    const right = build({ handedness: 'Right', palm: { x: 0.6, y: 0.4 } });
    const left = build({ handedness: 'Left', palm: { x: 0.6, y: 0.4 } });

    for (let i = 0; i < LANDMARK_COUNT; i += 1) {
      const r = right.landmarks[i]!;
      const l = left.landmarks[i]!;
      expect(l.x - 0.6).toBeCloseTo(-(r.x - 0.6), 12);
      expect(l.y).toBeCloseTo(r.y, 12);
    }
  });

  it('folds the middle and ring fingers toward the palm as curl increases', () => {
    const open = build({ curl: 0 });
    const folded = build({ curl: 1 });
    const palmOpen = palmPx(open.landmarks, 640, 480);
    const palmFolded = palmPx(folded.landmarks, 640, 480);

    const middleTip = (hand: RawHandFrame, palm: Point) =>
      distancePx(toPx(hand.landmarks[Landmark.MIDDLE_TIP]!, 640, 480), palm);
    const ringTip = (hand: RawHandFrame, palm: Point) =>
      distancePx(toPx(hand.landmarks[Landmark.RING_TIP]!, 640, 480), palm);

    // Folded tips come back to the palm; open tips are far out.
    expect(middleTip(folded, palmFolded)).toBeLessThan(
      middleTip(open, palmOpen) * 0.2,
    );
    expect(ringTip(folded, palmFolded)).toBeLessThan(ringTip(open, palmOpen) * 0.3);
  });

  it('leaves the index and pinky untouched by curl, since only two fingers fold', () => {
    const open = build({ curl: 0 });
    const folded = build({ curl: 1 });
    for (const index of [
      Landmark.INDEX_MCP,
      Landmark.INDEX_PIP,
      Landmark.INDEX_DIP,
      Landmark.INDEX_TIP,
      Landmark.PINKY_MCP,
      Landmark.PINKY_TIP,
      Landmark.THUMB_TIP,
    ]) {
      expect(folded.landmarks[index]!.x).toBeCloseTo(open.landmarks[index]!.x, 12);
      expect(folded.landmarks[index]!.y).toBeCloseTo(open.landmarks[index]!.y, 12);
    }
  });

  it('rotates the whole hand rather than shearing it', () => {
    const upright = build({ rollRad: 0 });
    const rolled = build({ rollRad: Math.PI / 2 });

    // A rigid rotation preserves every inter-landmark distance.
    const dist = (hand: RawHandFrame, a: number, b: number) =>
      distancePx(
        toPx(hand.landmarks[a]!, 640, 480),
        toPx(hand.landmarks[b]!, 640, 480),
      );
    for (const [a, b] of [
      [Landmark.WRIST, Landmark.MIDDLE_TIP],
      [Landmark.THUMB_TIP, Landmark.PINKY_TIP],
      [Landmark.INDEX_TIP, Landmark.RING_TIP],
    ] as const) {
      expect(dist(rolled, a, b)).toBeCloseTo(dist(upright, a, b), 6);
    }
  });

  it('rejects invalid dimensions and spans', () => {
    expect(() => build({ sourceWidthPx: 0 })).toThrow(RangeError);
    expect(() => build({ sourceHeightPx: -1 })).toThrow(RangeError);
    expect(() => build({ spanPx: 0 })).toThrow(RangeError);
  });
});

describe('handTemplateAtCurl', () => {
  it('matches the open template at curl 0 and clamps out-of-range curls', () => {
    expect(handTemplateAtCurl(0)).toEqual(handTemplateAtCurl(-5));
    expect(handTemplateAtCurl(1)).toEqual(handTemplateAtCurl(5));
    expect(handTemplateAtCurl(0)).toHaveLength(LANDMARK_COUNT);
  });

  it('keeps the wrist and MCPs fixed, so the palm does not wander while folding', () => {
    const open = handTemplateAtCurl(0);
    const folded = handTemplateAtCurl(1);
    for (const index of PALM_INDEX) {
      expect(folded[index]).toEqual(open[index]);
    }
  });
});

describe('clampPalmToSource', () => {
  it('leaves in-range palms untouched', () => {
    expect(clampPalmToSource({ x: 0.5, y: 0.5 }, 640, 480, 40)).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it('clamps to the margin in normalized units, per axis', () => {
    const clamped = clampPalmToSource({ x: -1, y: 2 }, 640, 480, 40);
    expect(clamped.x).toBeCloseTo(40 / 640, 12);
    expect(clamped.y).toBeCloseTo(1 - 40 / 480, 12);
  });

  it('degrades gracefully when the margin exceeds half the source', () => {
    const clamped = clampPalmToSource({ x: 0, y: 1 }, 100, 100, 500);
    expect(clamped).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('MouseSource', () => {
  function makeSource(overrides: Partial<ConstructorParameters<typeof MouseSource>[0]> = {}) {
    return new MouseSource({
      sourceWidthPx: 640,
      sourceHeightPx: 480,
      curlMs: 100,
      wobbleDeg: 0,
      wobbleMs: 1000,
      ...overrides,
    });
  }

  it('emits nothing before start() and nothing after stop()', () => {
    const source = makeSource();
    expect(source.frameAt(0)).toBeNull();

    source.start(0);
    expect(source.frameAt(0)).not.toBeNull();

    source.stop();
    expect(source.frameAt(10)).toBeNull();
  });

  it('identifies itself as a simulated mouse source', () => {
    const source = makeSource();
    source.start(0);
    const frame = source.frameAt(0)!;
    expect(frame.sourceId).toBe('mouse');
    expect(frame.provenance).toBe('simulated');
    expect(frame.timestampMs).toBe(0);
    expect(frame.hands).toHaveLength(1);
  });

  it('follows the pointer, with the palm under it', () => {
    const source = makeSource();
    source.start(0);
    source.setPointer({ x: 0.3, y: 0.7 });

    const frame = source.frameAt(0)!;
    const centroid = palmPx(frame.hands[0]!.landmarks, 640, 480);
    expect(centroid.x).toBeCloseTo(0.3 * 640, 6);
    expect(centroid.y).toBeCloseTo(0.7 * 480, 6);
  });

  it('clamps an off-stage pointer instead of losing the hand', () => {
    const source = makeSource();
    source.start(0);
    source.setPointer({ x: 5, y: -5 });

    const frame = source.frameAt(0)!;
    const centroid = palmPx(frame.hands[0]!.landmarks, 640, 480);
    expect(centroid.x).toBeCloseTo(640 - 40, 6);
    expect(centroid.y).toBeCloseTo(40, 6);
  });

  it('ignores a non-finite pointer update rather than corrupting the hand', () => {
    const source = makeSource();
    source.start(0);
    source.setPointer({ x: 0.2, y: 0.2 });
    source.setPointer({ x: Number.NaN, y: Number.NaN });

    const frame = source.frameAt(0)!;
    expect(frame.hands[0]!.landmarks.every((lm) => Number.isFinite(lm.x))).toBe(true);
    expect(source.pointerPosition).toEqual({ x: 0.2, y: 0.2 });
  });

  it('animates the curl over the configured duration in both directions', () => {
    const source = makeSource({ curlMs: 100 });
    source.start(0);
    source.setPointer({ x: 0.5, y: 0.5 }, true);

    expect(source.frameAt(0)!.hands[0]!.landmarks).toHaveLength(LANDMARK_COUNT);
    expect(source.currentCurl).toBe(0);

    source.frameAt(50);
    expect(source.currentCurl).toBeCloseTo(0.5, 6);

    source.frameAt(100);
    expect(source.currentCurl).toBeCloseTo(1, 6);

    // Holding past the end saturates rather than overshooting.
    source.frameAt(500);
    expect(source.currentCurl).toBe(1);

    source.setPressed(false);
    source.frameAt(550);
    expect(source.currentCurl).toBeCloseTo(0.5, 6);
    source.frameAt(600);
    expect(source.currentCurl).toBe(0);
  });

  it('starts open every time, so a restart cannot begin mid-gesture', () => {
    const source = makeSource();
    source.start(0);
    source.setPointer({ x: 0.5, y: 0.5 }, true);
    source.frameAt(1000);
    expect(source.currentCurl).toBe(1);

    source.stop();
    source.start(2000);
    expect(source.currentCurl).toBe(0);
  });

  it('toggles handedness and mirrors accordingly', () => {
    const source = makeSource();
    source.start(0);
    expect(source.handedness).toBe('Right');
    const right = source.frameAt(0)!.hands[0]!.landmarks;

    expect(source.toggleHandedness()).toBe('Left');
    const left = source.frameAt(0)!.hands[0]!.landmarks;

    for (let i = 0; i < LANDMARK_COUNT; i += 1) {
      expect(left[i]!.x - 0.5).toBeCloseTo(-(right[i]!.x - 0.5), 12);
    }

    expect(source.toggleHandedness()).toBe('Right');
  });

  it('does not let a lost frame drift the hand: same time, same output', () => {
    const source = makeSource();
    source.start(0);
    source.setPointer({ x: 0.42, y: 0.58 });
    const a = source.frameAt(16)!;
    const b = source.frameAt(16)!;
    expect(b.hands[0]!.landmarks).toEqual(a.hands[0]!.landmarks);
  });

  it('rejects invalid construction options', () => {
    expect(() => makeSource({ sourceWidthPx: 0 })).toThrow(RangeError);
    expect(() => makeSource({ sourceHeightPx: 0 })).toThrow(RangeError);
    expect(() => makeSource({ wobbleMs: 0 })).toThrow(RangeError);
  });
});
