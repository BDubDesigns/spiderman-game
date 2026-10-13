/**
 * Guards the committed identity fixtures (PLAN.md §10, §13 M1).
 *
 * Two kinds of check live here. The first is the obvious one: the JSON in
 * `fixtures/` must deep-equal what `fixtureGenerators.ts` produces, so the
 * committed input can never drift from the trajectory it claims to encode. The
 * second keeps the fixtures *meaningful* — a crossing clip whose hands do not
 * actually cross, or a reacquire clip whose absence is inside the grace window,
 * would still parse, still replay, and still test nothing.
 *
 * Every threshold comes from `IDENTITY` and every frame number is derived from
 * the clip, so retuning the config or changing a clip length re-derives these
 * checks instead of quietly invalidating them.
 */

import { describe, expect, it } from 'vitest';

import crossingFixture from '../../fixtures/identity-crossing.json';
import reacquireFixture from '../../fixtures/identity-reacquire.json';
import { IDENTITY } from '../config';
import {
  LANDMARK_COUNT,
  Landmark,
  type HandednessLabel,
  type RawHandFrame,
} from '../tracking/landmarkTypes';
import { buildCrossingClip, buildReacquireClip } from './fixtureGenerators';
import type { NormalizedPoint } from './mouseSource';
import { parseReplayClip, type ReplayClip, type ReplayFrame } from './replaySource';

/**
 * "Genuinely overlapping", for the crossing clip. Deliberately far tighter than
 * `IDENTITY.crossingRadius`: the clip must cover the pathological case where
 * position alone is nearly useless, not only the ordinary crossing case.
 */
const GENUINE_OVERLAP_DISTANCE = 0.05;

/** Palm center: the five landmarks the simulator and the gesture math use (§11.1). */
const PALM_LANDMARKS = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

function palmCenter(hand: RawHandFrame): NormalizedPoint {
  let x = 0;
  let y = 0;
  for (const index of PALM_LANDMARKS) {
    const landmark = hand.landmarks[index]!;
    x += landmark.x;
    y += landmark.y;
  }
  return { x: x / PALM_LANDMARKS.length, y: y / PALM_LANDMARKS.length };
}

function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Find a hand by label. Throwing rather than returning `undefined` keeps the
 * assertions below about the fixture, not about a missing-hand guard.
 */
function handWithLabel(frame: ReplayFrame, label: HandednessLabel): RawHandFrame {
  const hand = frame.hands.find((candidate) => candidate.handedness.label === label);
  if (!hand) throw new Error(`frame at t=${frame.timestampMs} has no ${label} hand`);
  return hand;
}

/** One stretch of frames in which a clip's only hand is not detected. */
interface Absence {
  /** How many consecutive frames have an empty `hands` array. */
  frames: number;
  /** Time from the last sighting before the gap to the first sighting after it. */
  ms: number;
  /** Palm-center distance between those two sightings. */
  jump: number;
  /** Index of the first frame in which the hand is seen again. */
  reappearsAtFrame: number;
}

/**
 * Every gap in the reacquire clip, measured the way an associator would
 * experience it: from the last observation to the next one.
 */
function absences(clip: ReplayClip): Absence[] {
  const present = clip.frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => frame.hands.length > 0);

  const result: Absence[] = [];
  for (let i = 1; i < present.length; i += 1) {
    const before = present[i - 1]!;
    const after = present[i]!;
    const missing = after.index - before.index - 1;
    if (missing === 0) continue;
    result.push({
      frames: missing,
      ms: after.frame.timestampMs - before.frame.timestampMs,
      jump: distance(
        palmCenter(before.frame.hands[0]!),
        palmCenter(after.frame.hands[0]!),
      ),
      reappearsAtFrame: after.index,
    });
  }
  return result;
}

function requireGap(
  gaps: Absence[],
  predicate: (gap: Absence) => boolean,
  description: string,
): Absence {
  const gap = gaps.find(predicate);
  if (!gap) throw new Error(`the clip has no absence ${description}`);
  return gap;
}

describe('identity-crossing.json', () => {
  const clip = parseReplayClip(crossingFixture);

  it('is exactly what the generator produces', () => {
    expect(crossingFixture).toEqual(buildCrossingClip());
  });

  it('reports the source shape the associator is tuned for', () => {
    expect(clip.name).toBe('identity-crossing');
    expect(clip.fps).toBe(24);
    expect(clip.frames).toHaveLength(24);
    expect(clip.sourceWidth).toBe(640);
    expect(clip.sourceHeight).toBe(480);
    // Synthetic, not recorded from a camera. Must never claim 'observed'.
    expect(clip.provenance).toBe('simulated');
  });

  it('has two complete 21-landmark hands in every frame, with no gaps', () => {
    for (const frame of clip.frames) {
      expect(frame.hands).toHaveLength(2);
      for (const hand of frame.hands) {
        expect(hand.landmarks).toHaveLength(LANDMARK_COUNT);
        expect(hand.handedness.score).toBeGreaterThan(0);
        expect(hand.handedness.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps one Left and one Right label for the whole clip', () => {
    for (const frame of clip.frames) {
      expect(frame.hands.map((hand) => hand.handedness.label).sort()).toEqual([
        'Left',
        'Right',
      ]);
    }
  });

  it('actually swaps the two hands from one side of the frame to the other', () => {
    const first = clip.frames[0]!;
    const last = clip.frames[clip.frames.length - 1]!;
    const leftStart = palmCenter(handWithLabel(first, 'Left'));
    const rightStart = palmCenter(handWithLabel(first, 'Right'));
    const leftEnd = palmCenter(handWithLabel(last, 'Left'));
    const rightEnd = palmCenter(handWithLabel(last, 'Right'));

    expect(leftStart.x).toBeLessThan(rightStart.x);
    expect(leftEnd.x).toBeGreaterThan(rightEnd.x);
    // More than a nudge: each hand finishes roughly where the other started.
    expect(leftEnd.x - leftStart.x).toBeGreaterThan(0.3);
    expect(rightStart.x - rightEnd.x).toBeGreaterThan(0.3);
    // Vertically offset at the ends, so the crossing is not a degenerate swap
    // along one axis that a position-only matcher could survive by accident.
    expect(rightStart.y - leftStart.y).toBeGreaterThan(0.05);
  });

  it('brings the palm centers genuinely close, for consecutive frames, without coinciding', () => {
    const separations = clip.frames.map((frame) =>
      distance(
        palmCenter(handWithLabel(frame, 'Left')),
        palmCenter(handWithLabel(frame, 'Right')),
      ),
    );
    const closest = Math.min(...separations);

    // "Close" must be true for longer than one sampled frame; a single frame
    // under the threshold could be luck rather than a crossing.
    let longestRun = 0;
    let run = 0;
    for (const separation of separations) {
      run = separation < GENUINE_OVERLAP_DISTANCE ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
    }

    expect(closest).toBeLessThan(GENUINE_OVERLAP_DISTANCE);
    expect(longestRun).toBeGreaterThanOrEqual(2);
    // Never exactly coincident: a zero-distance match is a different problem
    // from an identity swap, and this clip is about the latter.
    expect(closest).toBeGreaterThan(0);

    // And the crossing happens inside the window the associator treats as a
    // crossing, which is why handedness has to be the tiebreak.
    const withinCrossingRadius = separations.filter(
      (separation) => separation < IDENTITY.crossingRadius,
    );
    expect(withinCrossingRadius.length).toBeGreaterThanOrEqual(2);
  });
});

describe('identity-reacquire.json', () => {
  const clip = parseReplayClip(reacquireFixture);

  it('is exactly what the generator produces', () => {
    expect(reacquireFixture).toEqual(buildReacquireClip());
  });

  it('reports the source shape the associator is tuned for', () => {
    expect(clip.name).toBe('identity-reacquire');
    expect(clip.fps).toBe(24);
    expect(clip.frames).toHaveLength(32);
    expect(clip.sourceWidth).toBe(640);
    expect(clip.sourceHeight).toBe(480);
    expect(clip.provenance).toBe('simulated');
  });

  it('carries one complete Right hand, or none at all', () => {
    for (const frame of clip.frames) {
      expect(frame.hands.length).toBeLessThanOrEqual(1);
      for (const hand of frame.hands) {
        expect(hand.handedness.label).toBe('Right');
        expect(hand.landmarks).toHaveLength(LANDMARK_COUNT);
      }
    }
  });

  it('covers both a past-grace reacquisition and a within-grace hold', () => {
    const gaps = absences(clip);
    expect(gaps).toHaveLength(2);

    const long = requireGap(
      gaps,
      (gap) => gap.ms > IDENTITY.graceMs,
      'longer than IDENTITY.graceMs',
    );
    const short = requireGap(
      gaps,
      (gap) => gap.ms < IDENTITY.graceMs,
      'shorter than IDENTITY.graceMs',
    );

    // The spec floor at this frame rate: comfortably past the grace window, not
    // a millisecond over the line.
    const frameIntervalMs = 1000 / clip.fps;
    expect(long.frames).toBeGreaterThanOrEqual(
      Math.ceil(IDENTITY.graceMs / frameIntervalMs) + 4,
    );
    expect(long.ms).toBeGreaterThan(IDENTITY.graceMs);

    // The reappearance after the long gap is beyond `maxMatchDistance`, so the
    // hand cannot be reacquired on position alone.
    expect(long.jump).toBeGreaterThan(IDENTITY.maxMatchDistance);

    // The short gap is the opposite case: brief, and back where it left, so a
    // held identity still matches on position.
    expect(short.frames).toBeGreaterThan(0);
    expect(short.ms).toBeLessThan(IDENTITY.graceMs);
    expect(short.jump).toBeLessThan(IDENTITY.maxMatchDistance);

    // The lost-then-reacquired case is the one exercised first, so the clip has
    // a narrative order rather than two interchangeable gaps.
    expect(long.reappearsAtFrame).toBeLessThan(short.reappearsAtFrame);
  });
});
