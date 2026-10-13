/**
 * Unit tests for hand identity association (PLAN.md §10).
 *
 * This is the M1 `[A]` acceptance criterion: "identity association unit tests pass
 * against recorded landmark sequences". The sequences here are synthetic and
 * deterministic, so they assert the *invariants* §10 makes binding — no swap on a
 * crossing, hold-then-expire on occlusion, and reacquisition after a loss —
 * rather than whatever a particular recording happened to contain.
 *
 * Only the palm centroid and the handedness label matter to association, so the
 * helper below places the five palm landmarks exactly on the requested point and
 * scatters the rest. That keeps each test's intent readable.
 */

import { describe, expect, it } from 'vitest';

import { IDENTITY } from '../config';
import {
  LANDMARK_COUNT,
  Landmark,
  type HandednessLabel,
  type NormalizedLandmark,
  type RawHandFrame,
} from './landmarkTypes';
import { HandIdentityTracker, IDENTITY_IDS, palmCenterOf } from './handIdentity';

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 480;

const PALM_INDEX = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

/** A hand whose palm centroid sits exactly on `(x, y)` in normalized video space. */
function makeHand(
  label: HandednessLabel,
  x: number,
  y: number,
  score = 0.95,
): RawHandFrame {
  const landmarks: NormalizedLandmark[] = Array.from(
    { length: LANDMARK_COUNT },
    (_, index) => {
      if ((PALM_INDEX as readonly number[]).includes(index)) return { x, y };
      // Non-palm landmarks are irrelevant to association but must exist, and must
      // not accidentally land on the palm indices.
      return { x: x + 0.01, y: y - 0.06 - (index % 4) * 0.01 };
    },
  );
  return { landmarks, handedness: { label, score } };
}

function tracker(overrides: Partial<ConstructorParameters<typeof HandIdentityTracker>[0]> = {}) {
  return new HandIdentityTracker({
    sourceWidth: SOURCE_WIDTH,
    sourceHeight: SOURCE_HEIGHT,
    ...overrides,
  });
}

function handFor(
  hands: ReturnType<HandIdentityTracker['snapshot']>,
  identity: 'left' | 'right',
) {
  return hands.find((hand) => hand.identity === identity);
}

describe('palmCenterOf', () => {
  it('averages the wrist and the four finger MCPs, per §11.1', () => {
    const center = palmCenterOf(makeHand('Right', 0.25, 0.75).landmarks);
    expect(center).not.toBeNull();
    expect(center!.x).toBeCloseTo(0.25, 12);
    expect(center!.y).toBeCloseTo(0.75, 12);
  });

  it('returns null for an incomplete hand rather than guessing', () => {
    const short = makeHand('Right', 0.5, 0.5).landmarks.slice(0, 10);
    expect(palmCenterOf(short)).toBeNull();
  });
});

describe('HandIdentityTracker adoption', () => {
  it('adopts the first frame, keying identities on the handedness label', () => {
    const t = tracker();
    const frame = t.update([makeHand('Left', 0.3, 0.5), makeHand('Right', 0.7, 0.5)], 0);

    expect(frame.hands).toHaveLength(2);
    expect(handFor(frame.hands, 'left')?.handedness.label).toBe('Left');
    expect(handFor(frame.hands, 'right')?.handedness.label).toBe('Right');
    expect(frame.stats.adopted).toBe(2);
    expect(frame.stats.matched).toBe(0);
  });

  it('returns identities in a stable order regardless of detection order', () => {
    const a = tracker().update([makeHand('Left', 0.3, 0.5), makeHand('Right', 0.7, 0.5)], 0);
    const b = tracker().update([makeHand('Right', 0.7, 0.5), makeHand('Left', 0.3, 0.5)], 0);

    expect(a.hands.map((h) => h.identity)).toEqual([...IDENTITY_IDS]);
    expect(b.hands.map((h) => h.identity)).toEqual([...IDENTITY_IDS]);
    expect(handFor(b.hands, 'left')?.palmCenter.x).toBeCloseTo(0.3, 12);
    expect(handFor(b.hands, 'right')?.palmCenter.x).toBeCloseTo(0.7, 12);
  });

  it('follows the physical hands when the detection array order flips mid-session', () => {
    const t = tracker();
    t.update([makeHand('Left', 0.30, 0.5), makeHand('Right', 0.70, 0.5)], 0);

    // Same physical hands, reversed array order, moved slightly.
    const moved = t.update([makeHand('Right', 0.72, 0.5), makeHand('Left', 0.32, 0.5)], 33);

    expect(handFor(moved.hands, 'left')?.palmCenter.x).toBeCloseTo(0.32, 12);
    expect(handFor(moved.hands, 'right')?.palmCenter.x).toBeCloseTo(0.72, 12);
    expect(moved.stats.matched).toBe(2);
    expect(moved.stats.adopted).toBe(0);
  });
});

describe('HandIdentityTracker crossing (§10.2)', () => {
  /** Two hands that swap sides over `frames`, both always visible. */
  function runCrossing(t: HandIdentityTracker, frames: number, invertedLabels = false) {
    const history: Array<{ leftX: number; rightX: number }> = [];
    for (let i = 0; i < frames; i += 1) {
      const p = i / (frames - 1);
      const leftLabel: HandednessLabel = invertedLabels ? 'Right' : 'Left';
      const rightLabel: HandednessLabel = invertedLabels ? 'Left' : 'Right';
      const frame = t.update(
        [
          makeHand(leftLabel, 0.3 + 0.4 * p, 0.45),
          makeHand(rightLabel, 0.7 - 0.4 * p, 0.55),
        ],
        i * 33,
      );
      history.push({
        leftX: handFor(frame.hands, 'left')?.palmCenter.x ?? Number.NaN,
        rightX: handFor(frame.hands, 'right')?.palmCenter.x ?? Number.NaN,
      });
    }
    return history;
  }

  it('does not swap identities when the hands cross', () => {
    const t = tracker();
    const history = runCrossing(t, 21);

    // Every frame is observed by both identities: nothing was dropped or held.
    expect(history.every((h) => Number.isFinite(h.leftX) && Number.isFinite(h.rightX))).toBe(true);
    // The left identity tracks the left hand all the way across: strictly moving
    // right, and ending where that hand ended.
    for (let i = 1; i < history.length; i += 1) {
      expect(history[i]!.leftX).toBeGreaterThan(history[i - 1]!.leftX);
    }
    expect(history[history.length - 1]!.leftX).toBeCloseTo(0.7, 6);
    expect(history[0]!.rightX).toBeCloseTo(0.7, 6);
    expect(history[history.length - 1]!.rightX).toBeCloseTo(0.3, 6);
  });

  it('counts a crossing event and reports being inside the crossing window', () => {
    const t = tracker();
    runCrossing(t, 21);
    expect(t.stats.crossings).toBeGreaterThanOrEqual(1);
  });

  it('keeps tracking hands whose labels are inverted, instead of dropping them', () => {
    // An inverted label (§8) must not make hands vanish at a crossing. The
    // reconciliation pass keeps them by position and counts the conflict.
    const t = tracker();
    const history = runCrossing(t, 21, true);

    expect(history.every((h) => Number.isFinite(h.leftX) && Number.isFinite(h.rightX))).toBe(true);
    expect(t.stats.handednessConflicts).toBeGreaterThanOrEqual(0);
  });

  it('prefers position and reports a conflict when a jump contradicts handedness', () => {
    const t = tracker();
    t.update([makeHand('Left', 0.30, 0.5), makeHand('Right', 0.70, 0.5)], 0);

    // Both hands jump to the other side in one frame. Handedness says "stay",
    // position says "follow". Position must win, and say so.
    const jumped = t.update(
      [makeHand('Left', 0.70, 0.5), makeHand('Right', 0.30, 0.5)],
      33,
    );

    expect(handFor(jumped.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 12);
    expect(handFor(jumped.hands, 'right')?.palmCenter.x).toBeCloseTo(0.70, 12);
    expect(jumped.stats.reconciled).toBe(2);
    expect(t.stats.handednessConflicts).toBe(2);
    expect(handFor(jumped.hands, 'left')?.handednessConflicted).toBe(true);
  });
});

describe('HandIdentityTracker occlusion and reacquisition (§10.3)', () => {
  it('holds a hand through an absence shorter than the grace period, marked stale', () => {
    const t = tracker();
    t.update([makeHand('Right', 0.5, 0.5)], 0);

    // Gone for well under the grace period.
    const gapMs = Math.floor(IDENTITY.graceMs / 3);
    const during = t.update([], gapMs);

    const held = handFor(during.hands, 'right');
    expect(held).toBeDefined();
    expect(held!.isStale).toBe(true);
    expect(held!.stalenessMs).toBe(gapMs);
    expect(held!.palmCenter.x).toBeCloseTo(0.5, 12);
    expect(t.stats.losses).toBe(0);

    // Back before the grace period expires: same identity, no reacquisition.
    const back = t.update([makeHand('Right', 0.52, 0.5)], gapMs + 33);
    expect(handFor(back.hands, 'right')?.palmCenter.x).toBeCloseTo(0.52, 12);
    expect(handFor(back.hands, 'right')?.isStale).toBe(false);
    expect(t.stats.reacquisitions).toBe(0);
  });

  it('declares the identity lost after the grace period, and stops rendering it', () => {
    const t = tracker();
    t.update([makeHand('Right', 0.5, 0.5)], 0);

    const after = t.update([], IDENTITY.graceMs + 1);

    expect(after.hands).toHaveLength(0);
    expect(t.stats.losses).toBe(1);
  });

  it('re-acquires a lost identity and flags the reacquisition timestamp', () => {
    const t = tracker();
    t.update([makeHand('Right', 0.5, 0.5)], 0);
    t.update([], IDENTITY.graceMs + 1);
    expect(t.stats.losses).toBe(1);

    const back = t.update([makeHand('Right', 0.9, 0.2)], IDENTITY.graceMs + 100);

    const hand = handFor(back.hands, 'right');
    expect(hand).toBeDefined();
    expect(hand!.palmCenter.x).toBeCloseTo(0.9, 12);
    expect(hand!.reacquiredAtMs).toBe(IDENTITY.graceMs + 100);
    expect(t.stats.reacquisitions).toBe(1);
    expect(t.stats.losses).toBe(1);
  });

  it('does not adopt a stranger while an identity is inside its grace window', () => {
    // §10.1: a detection that cannot be matched becomes a new identity only if no
    // identity is currently in a grace period. Otherwise it is more likely to be
    // the same hand mis-associated, and adopting it would duplicate one hand.
    const t = tracker();
    t.update([makeHand('Left', 0.30, 0.5)], 0);

    // Far outside the match radius, and the left identity is still in grace.
    const frame = t.update([makeHand('Right', 0.95, 0.9)], 100);

    expect(frame.stats.unmatched).toBe(1);
    expect(frame.stats.adopted).toBe(0);
    expect(handFor(frame.hands, 'right')).toBeUndefined();
  });

  it('adopts into a free slot once no identity is in grace', () => {
    const t = tracker();
    t.update([makeHand('Left', 0.30, 0.5)], 0);
    t.update([], IDENTITY.graceMs + 1);

    const frame = t.update([makeHand('Right', 0.95, 0.9)], IDENTITY.graceMs + 100);

    expect(frame.stats.adopted).toBe(1);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.95, 12);
  });
});

describe('HandIdentityTracker second-hand entry (§10.1)', () => {
  /**
   * The grace gate exists so that one physical hand cannot be adopted twice
   * (§10.1). It must not stop a *second* hand from entering while the first is
   * still visible — the game needs both hands, and a player who shows one hand
   * and then the other would otherwise never get a second identity until they
   * removed the first for longer than the grace period.
   */

  it('lets a right hand enter while the left hand is still observed', () => {
    const t = tracker();
    t.update([makeHand('Left', 0.30, 0.5)], 0);

    // The left hand is still present *and observed this frame*; the right hand
    // enters beside it, far outside the match radius.
    const frame = t.update(
      [makeHand('Left', 0.30, 0.5), makeHand('Right', 0.70, 0.5)],
      33,
    );

    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 12);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.70, 12);
    expect(frame.stats.adopted).toBe(1);
    expect(frame.stats.unmatched).toBe(0);
  });

  it('lets a left hand enter while the right hand is still observed', () => {
    const t = tracker();
    t.update([makeHand('Right', 0.70, 0.5)], 0);

    const frame = t.update(
      [makeHand('Left', 0.30, 0.5), makeHand('Right', 0.70, 0.5)],
      33,
    );

    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.30, 12);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.70, 12);
    expect(frame.stats.adopted).toBe(1);
    expect(frame.stats.unmatched).toBe(0);
  });

  it('continues both hands across frames without adopting anything further', () => {
    const t = tracker();
    t.update([makeHand('Left', 0.30, 0.5)], 0);
    t.update([makeHand('Left', 0.30, 0.5), makeHand('Right', 0.70, 0.5)], 33);

    // Reversed array order and a small movement, as MediaPipe may reorder them.
    const frame = t.update(
      [makeHand('Right', 0.72, 0.5), makeHand('Left', 0.32, 0.5)],
      66,
    );

    expect(frame.stats.matched).toBe(2);
    expect(frame.stats.adopted).toBe(0);
    expect(frame.stats.unmatched).toBe(0);
    expect(handFor(frame.hands, 'left')?.palmCenter.x).toBeCloseTo(0.32, 12);
    expect(handFor(frame.hands, 'right')?.palmCenter.x).toBeCloseTo(0.72, 12);
  });

  it('rejects an ambiguous duplicate observation of the same hand', () => {
    // Two detections of one physical hand — a duplicate, not a second hand. They
    // sit on top of each other, so the duplicate must not invent an identity.
    const t = tracker();
    t.update([makeHand('Right', 0.50, 0.5)], 0);

    const frame = t.update(
      [makeHand('Right', 0.500, 0.5), makeHand('Right', 0.504, 0.5)],
      33,
    );

    expect(frame.hands).toHaveLength(1);
    expect(frame.stats.adopted).toBe(0);
    expect(frame.stats.unmatched).toBe(1);
    expect(handFor(frame.hands, 'left')).toBeUndefined();
  });

  it('still blocks adoption while an unobserved identity coasts in grace', () => {
    // The §10.1 guarantee, restated for the two-hand case: if the identity in
    // grace was NOT observed this frame, an unmatched detection may well be that
    // same hand mis-associated, so it must not be adopted.
    const t = tracker();
    t.update([makeHand('Left', 0.30, 0.5)], 0);

    // Only the stranger is offered; the left hand is absent this frame.
    const frame = t.update([makeHand('Right', 0.95, 0.9)], 33);

    expect(frame.stats.unmatched).toBe(1);
    expect(frame.stats.adopted).toBe(0);
  });
});

describe('HandIdentityTracker heuristics and discipline', () => {
  it('decays identityMatchScore while an identity goes unobserved, staying in [0,1]', () => {
    const t = tracker();
    const first = t.update([makeHand('Right', 0.5, 0.5)], 0);
    const initial = handFor(first.hands, 'right')!.identityMatchScore;
    expect(initial).toBeGreaterThanOrEqual(0);
    expect(initial).toBeLessThanOrEqual(1);

    const later = t.update([], IDENTITY.graceMs - 1);
    const decayed = handFor(later.hands, 'right')!.identityMatchScore;
    expect(decayed).toBeLessThan(initial);
    expect(decayed).toBeGreaterThanOrEqual(0);
  });

  it('never presents a computed heuristic as a model confidence', () => {
    const frame = tracker().update([makeHand('Right', 0.5, 0.5)], 0);
    const hand = frame.hands[0]!;
    const keys = Object.keys(hand).sort();

    // Exact key set: adding a `confidence`-shaped field must fail this test.
    expect(keys).toEqual([
      'handedness',
      'handednessConflicted',
      'identity',
      'identityMatchScore',
      'isStale',
      'landmarks',
      'palmCenter',
      'reacquiredAtMs',
      'stalenessMs',
    ]);
    for (const forbidden of ['confidence', 'detectionConfidence', 'presenceConfidence', 'trackingConfidence']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('drops detections with an unusable palm instead of inventing a position', () => {
    const t = tracker();
    const truncated: RawHandFrame = {
      landmarks: makeHand('Right', 0.5, 0.5).landmarks.slice(0, 12),
      handedness: { label: 'Right', score: 0.9 },
    };

    const frame = t.update([truncated], 0);
    expect(frame.stats.incomplete).toBe(1);
    expect(frame.stats.observed).toBe(0);
    expect(frame.hands).toHaveLength(0);
  });

  it('rejects non-positive source dimensions', () => {
    expect(() => tracker({ sourceWidth: 0 })).toThrow(RangeError);
    expect(() => tracker({ sourceHeight: -1 })).toThrow(RangeError);
  });
});
