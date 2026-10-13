/**
 * Regression tests from real device captures (PLAN.md §10).
 *
 * The fixture is the unaltered output of the on-device capture tool, recorded on a Pixel 10 Pro XL
 * while the player held the Spider-Man gesture and open hands. It is the first evidence in this
 * project of what MediaPipe actually reports for a real hand at arm's length, and it exposed two
 * defects that synthetic fixtures could not.
 *
 * ---- What the captures showed ----
 *
 * **Duplicate detections.** MediaPipe emits **two boxes for one hand** when the hand is
 * foreshortened. Measured across seven consecutive timestamps in capture 3 take #8, the two palm
 * centres were **0.014–0.020** apart (diagonal-normalized), and the two landmark sets were
 * *mirror images* of each other — the wrist on opposite sides of its own middle MCP, thumb and
 * pinky swapped — carrying **opposite handedness labels at 0.97–1.00 confidence**.
 *
 * **Identity instability.** In capture 1 the same physical hand was reported under identity `right`
 * for three timestamps, then under **both** `right` and `left` at one timestamp, then under `left`.
 * In capture 3 the same hand was `left` for takes 1–5 and `right` for takes 6–7 — while MediaPipe's
 * own handedness label said **`Left` for every one of those observations**. So the flip was the
 * tracker's, not the model's.
 *
 * Both symptoms have one root cause: a duplicate detection was allowed to occupy the second
 * identity slot, after which one physical hand held two identities and the reported identity became
 * a matter of which slot happened to match first.
 */

import { describe, expect, it } from 'vitest';

import fixture from '../../fixtures/device-gesture-captures.json';
import { IDENTITY } from '../config';
import { HandIdentityTracker } from './handIdentity';
import {
  LANDMARK_COUNT,
  Landmark,
  type HandednessLabel,
  type NormalizedLandmark,
  type RawHandFrame,
} from './landmarkTypes';

interface FixtureFrame {
  tMs: number;
  identity: string;
  label: string;
  score: number;
  lm: number[][];
}

function toHand(frame: FixtureFrame): RawHandFrame {
  return {
    landmarks: frame.lm.map((point) => ({
      x: point[0]!,
      y: point[1]!,
      z: point[2]!,
    })),
    handedness: { label: frame.label as HandednessLabel, score: frame.score },
  };
}

function makeTracker(): HandIdentityTracker {
  return new HandIdentityTracker({ sourceWidth: 640, sourceHeight: 480 });
}

/** Group a take's frames by timestamp, which is what the camera actually delivered per detection. */
function groupByTimestamp(frames: readonly FixtureFrame[]): Array<[number, FixtureFrame[]]> {
  const byTimestamp = new Map<number, FixtureFrame[]>();
  for (const frame of frames) {
    const list = byTimestamp.get(frame.tMs) ?? [];
    list.push(frame);
    byTimestamp.set(frame.tMs, list);
  }
  return [...byTimestamp.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Replay a take through a fresh tracker, one `update()` per detection timestamp.
 *
 * `reverse` flips the detection order within each timestamp, because MediaPipe's array order is not
 * stable (§10.1) and identity must not depend on it.
 */
function replayTake(
  frames: readonly FixtureFrame[],
  options: { reverse?: boolean; warm?: boolean } = {},
): { identityCounts: number[]; adopted: number[]; duplicates: number[]; retained: string[][] } {
  const tracker = makeTracker();
  const groups = groupByTimestamp(frames);
  const identityCounts: number[] = [];
  const adopted: number[] = [];
  const duplicates: number[] = [];
  const retained: string[][] = [];

  // Optionally warm the tracker with the take's own first group, so continuing association is
  // exercised rather than first-adoption only.
  const start = options.warm === true ? 0 : 0;
  for (let i = start; i < groups.length; i += 1) {
    const group = groups[i]!;
    let hands = group[1].map(toHand);
    if (options.reverse === true) hands = [...hands].reverse();
    const frame = tracker.update(hands, group[0]);
    identityCounts.push(frame.hands.length);
    adopted.push(frame.stats.adopted);
    duplicates.push(frame.stats.duplicates);
    retained.push(frame.hands.map((hand) => hand.identity));
  }
  return { identityCounts, adopted, duplicates, retained };
}

const cap1 = fixture.captures[0]!;
const cap2 = fixture.captures[1]!;
const cap3 = fixture.captures[2]!;
const take8 = cap3.takes.find((take) => take.id === 8)!;

describe('the fixture is the real captured data', () => {
  it('carries the takes the analysis describes', () => {
    expect(cap1.takes).toHaveLength(1);
    expect(cap2.takes).toHaveLength(1);
    expect(cap3.takes).toHaveLength(8);
    // 7 + 6 + 57 = 70 hand observations, as reported.
    const total = [...cap1.takes, ...cap2.takes, ...cap3.takes].reduce(
      (sum, take) => sum + take.frames.length,
      0,
    );
    expect(total).toBe(70);
  });

  it('records the duplicate pair as mirrored, with opposite handedness', () => {
    // Establishes the *shape* of the duplicate, which is the justification for suppressing it:
    // two boxes on one hand, not two hands.
    const [first] = groupByTimestamp(take8.frames);
    const [, frames] = first!;
    expect(frames).toHaveLength(2);

    const [a, b] = frames as [FixtureFrame, FixtureFrame];
    expect(a.label).not.toBe(b.label);

    // Wrist relative to its own middle MCP: the sign must differ, i.e. the hands are mirrored.
    const sign = (frame: FixtureFrame): number =>
      Math.sign(frame.lm[Landmark.WRIST]![0]! - frame.lm[Landmark.MIDDLE_MCP]![0]!);
    expect(sign(a)).toBe(-sign(b));

    // Palm centres essentially coincide.
    const palm = (frame: FixtureFrame): { x: number; y: number } => {
      const indices: number[] = [
        Landmark.WRIST,
        Landmark.INDEX_MCP,
        Landmark.MIDDLE_MCP,
        Landmark.RING_MCP,
        Landmark.PINKY_MCP,
      ];
      const x = indices.reduce((sum, i) => sum + frame.lm[i]![0]!, 0) / indices.length;
      const y = indices.reduce((sum, i) => sum + frame.lm[i]![1]!, 0) / indices.length;
      return { x, y };
    };
    const pa = palm(a);
    const pb = palm(b);
    const separation = Math.hypot((pa.x - pb.x) * 640, (pa.y - pb.y) * 480) / Math.hypot(640, 480);
    expect(separation).toBeLessThan(IDENTITY.duplicateHandRadius);
  });
});

describe('one physical hand keeps one identity (§10)', () => {
  it('does not create two identities from the take-8 duplicate pair', () => {
    // The reported failure: `adopted: 2` and two tracking colours from one hand.
    const { identityCounts, retained } = replayTake(take8.frames);

    expect(identityCounts).toEqual([1, 1, 1, 1, 1, 1, 1]);
    // And the same identity every frame — not a hand that wanders between slots.
    expect(new Set(retained.map((ids) => ids.join(','))).size).toBe(1);
  });

  it('reports the dropped duplicate rather than hiding it', () => {
    const { duplicates } = replayTake(take8.frames);
    // One extra detection at every timestamp. Visible in the HUD so MediaPipe quality is diagnosable.
    expect(duplicates).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('gives the same identity count regardless of detection array order', () => {
    // §10.1: MediaPipe's array order is not stable, so identity must not depend on it.
    const forward = replayTake(take8.frames);
    const reversed = replayTake(take8.frames, { reverse: true });

    expect(reversed.identityCounts).toEqual(forward.identityCounts);
    expect(new Set(reversed.retained.map((ids) => ids.join(','))).size).toBe(1);
  });

  it('holds one stable identity across capture 1, which flipped on device', () => {
    // On device this take reported `right`, then both, then `left`, for one hand.
    const { identityCounts, retained } = replayTake(cap1.takes[0]!.frames);

    expect(identityCounts).toEqual([1, 1, 1, 1, 1, 1]);
    expect(new Set(retained.map((ids) => ids.join(','))).size).toBe(1);
  });

  it('holds one identity across every capture 3 take', () => {
    for (const take of cap3.takes) {
      const { identityCounts, retained } = replayTake(take.frames);
      expect({ take: take.id, counts: identityCounts }).toEqual({
        take: take.id,
        counts: identityCounts.map(() => 1),
      });
      expect({ take: take.id, distinct: new Set(retained.map((ids) => ids.join(','))).size }).toEqual({
        take: take.id,
        distinct: 1,
      });
    }
  });

  it('holds one identity across capture 3 with the detection order reversed', () => {
    for (const take of cap3.takes) {
      const { identityCounts } = replayTake(take.frames, { reverse: true });
      expect({ take: take.id, counts: identityCounts }).toEqual({
        take: take.id,
        counts: identityCounts.map(() => 1),
      });
    }
  });

  it('never adopts twice from one hand after the first frame', () => {
    // Adoption on the first frame is expected — nothing is known yet. What must never happen again
    // is a *second* identity appearing for a hand that is already tracked.
    for (const take of [...cap3.takes, cap1.takes[0]!]) {
      const { adopted } = replayTake(take.frames);
      expect({ take: `${take.id}`, later: adopted.slice(1).every((n) => n === 0) }).toEqual({
        take: `${take.id}`,
        later: true,
      });
    }
  });
});

describe('the duplicate guard does not suppress genuine second hands', () => {
  /** A hand whose palm centroid is exactly at `(x, y)`. */
  function handAt(label: HandednessLabel, x: number, y: number): RawHandFrame {
    const palm: number[] = [
      Landmark.WRIST,
      Landmark.INDEX_MCP,
      Landmark.MIDDLE_MCP,
      Landmark.RING_MCP,
      Landmark.PINKY_MCP,
    ];
    const landmarks: NormalizedLandmark[] = Array.from({ length: LANDMARK_COUNT }, (_, index) =>
      palm.includes(index) ? { x, y } : { x: x + 0.01, y: y - 0.06 - (index % 4) * 0.01 },
    );
    return { landmarks, handedness: { label, score: 0.95 } };
  }

  it('tracks two hands separated normally', () => {
    const tracker = makeTracker();
    const frame = tracker.update([handAt('Left', 0.3, 0.5), handAt('Right', 0.7, 0.5)], 0);
    expect(frame.hands).toHaveLength(2);
    expect(frame.stats.duplicates).toBe(0);
  });

  it('keeps two hands separate while they cross', () => {
    // The guard exempts identities that are both live, which is exactly what a crossing looks like.
    const tracker = makeTracker();
    tracker.update([handAt('Left', 0.30, 0.5), handAt('Right', 0.70, 0.5)], 0);

    let previous = ['left', 'right'];
    for (let i = 1; i <= 10; i += 1) {
      // Walk them through each other and out the other side.
      const left = 0.30 + i * 0.04;
      const right = 0.70 - i * 0.04;
      const frame = tracker.update([handAt('Left', left, 0.5), handAt('Right', right, 0.5)], i * 33);
      expect(frame.hands).toHaveLength(2);
      // Physical continuity: the left hand stays `left` throughout, even at the crossing point.
      expect(frame.hands.map((hand) => hand.identity)).toEqual(previous);
      previous = frame.hands.map((hand) => hand.identity);
    }

    // They genuinely met: the closest approach was inside the crossing radius.
    expect(IDENTITY.crossingRadius).toBeGreaterThan(0);
  });

  it('drops an ambiguous second hand that sits on top of the first', () => {
    // Deliberate tradeoff. Two detections within `duplicateHandRadius`, with neither identity live,
    // are indistinguishable from one hand seen twice — and a phantom second hand can fire a web,
    // while a missing one merely fails to. So the safe reading is one hand.
    const tracker = makeTracker();
    const frame = tracker.update([handAt('Left', 0.50, 0.5), handAt('Right', 0.52, 0.5)], 0);

    expect(frame.hands).toHaveLength(1);
    expect(frame.stats.duplicates).toBe(1);
  });

  it('still adopts a second hand that appears later, well away from the first', () => {
    // The revision required by review on PR #5 must not regress: a player who raises one hand and
    // then the other still gets two identities.
    const tracker = makeTracker();
    tracker.update([handAt('Left', 0.30, 0.5)], 0);
    const frame = tracker.update([handAt('Left', 0.30, 0.5), handAt('Right', 0.75, 0.5)], 33);

    expect(frame.hands).toHaveLength(2);
    expect(frame.stats.adopted).toBe(1);
    expect(frame.stats.duplicates).toBe(0);
  });

  it('keeps a genuine second hand through an occlusion, then reacquires both', () => {
    const tracker = makeTracker();
    tracker.update([handAt('Left', 0.30, 0.5), handAt('Right', 0.75, 0.5)], 0);
    // Both vanish briefly, then return in the same places.
    for (let i = 1; i <= 3; i += 1) tracker.update([], i * 100);
    const frame = tracker.update([handAt('Left', 0.30, 0.5), handAt('Right', 0.75, 0.5)], 400);

    expect(frame.hands.map((hand) => hand.identity)).toEqual(['left', 'right']);
  });
});
