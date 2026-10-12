/**
 * Generators for the identity-association fixtures (PLAN.md §10, §13 M1).
 *
 * Identity association is the one tracker behaviour that cannot be judged from a
 * single frame. It is only wrong when a hand is followed across time, and the two
 * failures that matter — two identities swapping as the hands cross, and a hand
 * that left the frame being reacquired as a stranger — are invisible unless the
 * input is known exactly. These generators are that known input.
 *
 * ---- Why generate instead of hand-writing the JSON ----
 *
 * The fixtures are geometry, and every landmark comes from `buildSyntheticHand`,
 * so the committed clips stay consistent with the hands the simulator already
 * renders. `fixtureGenerators.test.ts` asserts the committed JSON deep-equals
 * what these functions produce, so changing a trajectory here without
 * regenerating is a loud failure instead of a fixture that quietly stops testing
 * what its name claims.
 *
 * ---- Determinism ----
 *
 * Every position is a closed-form function of the frame index. No randomness, no
 * clock, no I/O, so regenerating on another machine reproduces the same bytes.
 * That is what makes committed generated output a legitimate thing to compare
 * against.
 */

import {
  LANDMARK_COUNT,
  type FrameProvenance,
  type HandednessLabel,
} from '../tracking/landmarkTypes';
import { buildSyntheticHand, type NormalizedPoint } from './mouseSource';

/** One `[x, y]` landmark pair. `z` is never written (PLAN.md §8 Rule C). */
export type FixtureLandmark = [number, number];

/** One hand as it appears in a fixture frame. */
export interface FixtureHand {
  handedness: HandednessLabel;
  handednessScore: number;
  landmarks: FixtureLandmark[];
}

/** One fixture frame: a clip-relative timestamp and the hands seen at it. */
export interface FixtureFrame {
  /** Milliseconds from the start of the clip. */
  t: number;
  /** Empty when no hand is detected; a valid observation, not a malformed frame. */
  hands: FixtureHand[];
}

/** The on-disk fixture shape accepted by `parseReplayClip`. */
export interface FixtureClip {
  name: string;
  fps: number;
  source: { width: number; height: number };
  provenance: FrameProvenance;
  frames: FixtureFrame[];
}

/** Matches `fixtures/replay-sweep.json`, so every fixture shares one source. */
const SOURCE_WIDTH_PX = 640;
const SOURCE_HEIGHT_PX = 480;
/** `SIM.handSpanPx`: the same hand size the interactive simulator uses. */
const SPAN_PX = 120;
/** An open hand. These clips are about identity, not gesture (M2's problem). */
const CURL = 0;
const ROLL_RAD = 0;
/** Confident but not perfect, matching `SIM.handednessScore`. */
const HANDEDNESS_SCORE = 0.97;

const FIXTURE_FPS = 24;
const CROSSING_FRAME_COUNT = 24;
const REACQUIRE_FRAME_COUNT = 32;

/**
 * Six decimals. The fixtures are compared against generated objects by deep
 * equality, so the value written must be the value recomputed, and rounding
 * first is what makes the two agree bit for bit on any platform.
 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Timestamp convention shared with `fixtures/replay-sweep.json`. */
function timestampMs(index: number): number {
  return Math.round((index * 1000) / FIXTURE_FPS);
}

/** Build one hand at a palm anchor, in the fixture wire format. */
function fixtureHand(palm: NormalizedPoint, handedness: HandednessLabel): FixtureHand {
  const hand = buildSyntheticHand({
    palm,
    sourceWidthPx: SOURCE_WIDTH_PX,
    sourceHeightPx: SOURCE_HEIGHT_PX,
    spanPx: SPAN_PX,
    curl: CURL,
    rollRad: ROLL_RAD,
    handedness,
    handednessScore: HANDEDNESS_SCORE,
  });

  if (hand.landmarks.length !== LANDMARK_COUNT) {
    // Unreachable unless the simulator template changes. Fail here, where the
    // cause is obvious, rather than in `parseReplayClip` with a path-qualified
    // message about a fixture that was never written.
    throw new Error(
      `synthetic hand produced ${hand.landmarks.length} landmarks, expected ${LANDMARK_COUNT}`,
    );
  }

  return {
    handedness: hand.handedness.label,
    handednessScore: hand.handedness.score,
    landmarks: hand.landmarks.map((landmark): FixtureLandmark => [
      round6(landmark.x),
      round6(landmark.y),
    ]),
  };
}

/** Palm centers at the first and last frame of the crossing clip. */
const CROSSING_START_X = 0.3;
const CROSSING_END_X = 0.7;
/**
 * Vertical offset between the palms at the ends, split around `CROSSING_CENTER_Y`.
 * The offset closes to a few thousandths as the hands meet: a perfect coincidence
 * would be a degenerate input whose "correct" answer is undefined, and the fixture
 * needs a defined answer. Keeping the ends vertically separated also stops the
 * crossing from being a pure one-axis swap, which a position-only matcher could
 * survive by accident.
 */
const CROSSING_Y_OFFSET = 0.06;
const CROSSING_CENTER_Y = 0.5;

/**
 * Two hands that approach, cross and separate, swapping sides by the last frame.
 *
 * Both hands are present in every frame and keep their handedness label, so the
 * only way to avoid swapping identities is to trust the label over the position
 * during the crossing — which is exactly the behaviour `IDENTITY.crossingRadius`
 * describes.
 */
export function buildCrossingClip(): FixtureClip {
  const frames: FixtureFrame[] = [];
  for (let index = 0; index < CROSSING_FRAME_COUNT; index += 1) {
    const progress = index / (CROSSING_FRAME_COUNT - 1);
    // Cosine, so the vertical approach mirrors the horizontal one and the palms
    // are closest to each other where they are closest in x.
    const swing = CROSSING_Y_OFFSET * Math.cos(Math.PI * progress);
    const left: NormalizedPoint = {
      x: CROSSING_START_X + (CROSSING_END_X - CROSSING_START_X) * progress,
      y: CROSSING_CENTER_Y - swing,
    };
    const right: NormalizedPoint = {
      x: CROSSING_END_X - (CROSSING_END_X - CROSSING_START_X) * progress,
      y: CROSSING_CENTER_Y + swing,
    };
    frames.push({
      t: timestampMs(index),
      // A stable array order makes the committed fixture readable. Consumers must
      // not rely on it (PLAN.md §10) — the labels are the identity signal.
      hands: [fixtureHand(left, 'Left'), fixtureHand(right, 'Right')],
    });
  }

  return {
    name: 'identity-crossing',
    fps: FIXTURE_FPS,
    source: { width: SOURCE_WIDTH_PX, height: SOURCE_HEIGHT_PX },
    provenance: 'simulated',
    frames,
  };
}

/**
 * The reacquire clip's plan, in frame indices:
 *
 * ```
 *  0..5    present, drifting left          (last seen at t=208 ms)
 *  6..24   ABSENT  — 19 frames = 834 ms    (longer than IDENTITY.graceMs = 600 ms)
 * 25..27   present, far away on the right  (0.56 from the last sighting)
 * 28..29   ABSENT  — 2 frames = 125 ms     (inside the grace window)
 * 30..31   present, back where it left     (0.0016 from the last sighting)
 * ```
 *
 * Two gaps on purpose: the long one forces the lost-identity path and the short
 * one exercises the held-identity path, in one clip. The long gap is also beyond
 * `IDENTITY.maxMatchDistance`, so position alone cannot reacquire the hand; the
 * short gap is well inside it, so position alone can.
 *
 * The long gap is capped at 19 frames for the 32-frame budget. Nineteen is the
 * floor the fixture spec asks for at 24 fps: `ceil(600 / (1000/24)) + 4`.
 */
const REACQUIRE_LAST_SEEN_BEFORE_LONG_GAP = 5;
const REACQUIRE_FIRST_SEEN_AFTER_LONG_GAP = 25;
const REACQUIRE_LAST_SEEN_BEFORE_SHORT_GAP = 27;
const REACQUIRE_FIRST_SEEN_AFTER_SHORT_GAP = 30;

/** Where the palm is at `index`, or `null` when the hand is not detected. */
function reacquirePalm(index: number): NormalizedPoint | null {
  if (index <= REACQUIRE_LAST_SEEN_BEFORE_LONG_GAP) {
    // Drifts toward the left edge as the tracker loses it.
    return { x: 0.3 - 0.016 * index, y: 0.5 };
  }
  if (index < REACQUIRE_FIRST_SEEN_AFTER_LONG_GAP) return null;
  if (index <= REACQUIRE_LAST_SEEN_BEFORE_SHORT_GAP) {
    const step = index - REACQUIRE_FIRST_SEEN_AFTER_LONG_GAP;
    return { x: 0.76 + 0.01 * step, y: 0.36 - 0.01 * step };
  }
  if (index < REACQUIRE_FIRST_SEEN_AFTER_SHORT_GAP) return null;
  const step = index - REACQUIRE_FIRST_SEEN_AFTER_SHORT_GAP;
  // Two thousandths from the previous sighting: close enough that a matcher
  // holding the identity still matches on position.
  return { x: 0.7815 + 0.001 * step, y: 0.3395 - 0.001 * step };
}

/**
 * One hand that leaves, returns somewhere unrecognisable, blinks out briefly and
 * comes back where it was. The label never changes, so a reacquisition that
 * reports a new identity is a failure of the associator, not an ambiguity in the
 * input.
 */
export function buildReacquireClip(): FixtureClip {
  const frames: FixtureFrame[] = [];
  for (let index = 0; index < REACQUIRE_FRAME_COUNT; index += 1) {
    const palm = reacquirePalm(index);
    frames.push({
      t: timestampMs(index),
      hands: palm ? [fixtureHand(palm, 'Right')] : [],
    });
  }

  return {
    name: 'identity-reacquire',
    fps: FIXTURE_FPS,
    source: { width: SOURCE_WIDTH_PX, height: SOURCE_HEIGHT_PX },
    provenance: 'simulated',
    frames,
  };
}

/** One `[x, y]` pair, spaced the way `fixtures/replay-sweep.json` is spaced. */
function serializeLandmark([x, y]: FixtureLandmark): string {
  return `[${JSON.stringify(x)}, ${JSON.stringify(y)}]`;
}

function serializeHand(hand: FixtureHand): string {
  const landmarks = hand.landmarks.map((landmark) => serializeLandmark(landmark));
  return (
    `{ "handedness": ${JSON.stringify(hand.handedness)}, ` +
    `"handednessScore": ${JSON.stringify(hand.handednessScore)}, ` +
    `"landmarks": [${landmarks.join(', ')}] }`
  );
}

function serializeFrame(frame: FixtureFrame): string {
  const hands = frame.hands.map((hand) => serializeHand(hand));
  return `{ "t": ${JSON.stringify(frame.t)}, "hands": [${hands.join(', ')}] }`;
}

/**
 * Render a clip as the committed fixture text.
 *
 * One frame per line: a 32-frame clip is then still readable in a diff, and the
 * generated file gets no reformatting pass that could hide a change in the
 * numbers. Hand-rolled rather than `JSON.stringify(.., null, 2)` because the
 * latter explodes each landmark onto its own line.
 */
export function serializeClip(clip: FixtureClip): string {
  const frameLines = clip.frames.map((frame) => `    ${serializeFrame(frame)}`);
  return (
    [
      '{',
      `  "name": ${JSON.stringify(clip.name)},`,
      `  "fps": ${JSON.stringify(clip.fps)},`,
      `  "source": { "width": ${JSON.stringify(clip.source.width)}, ` +
        `"height": ${JSON.stringify(clip.source.height)} },`,
      `  "provenance": ${JSON.stringify(clip.provenance)},`,
      '  "frames": [',
      frameLines.join(',\n'),
      '  ]',
      '}',
    ].join('\n') + '\n'
  );
}
