/**
 * JSON landmark replay harness (PLAN.md §13 M0, §21.4).
 *
 * Replays a recorded or generated sequence of hands on a timer, so the whole
 * render pipeline can be driven deterministically with no camera.
 *
 * Like `MouseSource`, this is a **permanent fixture** (PLAN.md §16.3), not
 * scaffolding to be deleted: in M1 it becomes the regression input for identity
 * association, and in M2 for gesture classification, because a JSON sequence is
 * the only way to test those against a known-correct input.
 *
 * ---- Purity (PLAN.md §6.1) ----
 *
 * This module has no DOM, no canvas, no MediaPipe types, and does no I/O. The
 * caller loads the JSON (at M0 via a bundled import; from M1, real recordings
 * will be fetched) and hands the parsed value to {@link parseReplayClip}, which
 * validates it. Frames are pulled by the render loop through the shared
 * `HandFrameSource` contract, so replay is a drop-in for the live tracker.
 *
 * ---- Fixture format ----
 *
 * ```json
 * {
 *   "name": "sweep-and-web-gesture",
 *   "fps": 24,
 *   "source": { "width": 640, "height": 480 },
 *   "provenance": "simulated",
 *   "frames": [
 *     { "t": 0, "hands": [
 *       { "handedness": "Right", "handednessScore": 0.97,
 *         "landmarks": [[0.27, 0.69], [0.18, 0.61], ...] }
 *     ] }
 *   ]
 * }
 * ```
 *
 * - `t` is the frame's timestamp in ms from the start of the clip.
 * - `landmarks` entries may be `[x, y]`, `[x, y, z]`, or `{ "x": .., "y": .., "z": .. }`.
 *   `z` is optional and, per PLAN.md §8 Rule C, is never used for screen position.
 * - `provenance` is optional and defaults to `"simulated"`. A clip recorded from
 *   a real camera must say `"observed"` so nothing downstream mistakes synthetic
 *   input for a measurement.
 * - There are deliberately no confidence fields per hand beyond the model's own
 *   handedness `score` (PLAN.md §5.1).
 */

import { REPLAY } from '../config';
import {
  LANDMARK_COUNT,
  type FrameProvenance,
  type HandFrameSource,
  type Handedness,
  type HandednessLabel,
  type NormalizedLandmark,
  type RawFrame,
  type RawHandFrame,
} from '../tracking/landmarkTypes';

/** One frame of a replay clip, in clip time. */
export interface ReplayFrame {
  /** Milliseconds from the start of the clip. Non-decreasing across a clip. */
  timestampMs: number;
  hands: RawHandFrame[];
}

/** A validated replay clip. */
export interface ReplayClip {
  name: string;
  /** Frames per second the clip was captured at. Always positive. */
  fps: number;
  /** Intrinsic source dimensions the landmarks are normalized against (§8 Rule A). */
  sourceWidth: number;
  sourceHeight: number;
  frames: ReplayFrame[];
  provenance: FrameProvenance;
  /** Total clip length in ms, including the display interval of the last frame. */
  durationMs: number;
}

/** Thrown when a fixture does not match the documented format. */
export class ReplayClipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayClipError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string): never {
  throw new ReplayClipError(`${path}: expected ${expected}`);
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'a finite number');
  }
  return value;
}

function requirePositiveNumber(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (n <= 0) fail(path, 'a positive number');
  return n;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'a non-empty string');
  }
  return value;
}

/** Parse one landmark, accepting the tuple or object form. */
function parseLandmark(value: unknown, path: string): NormalizedLandmark {
  if (Array.isArray(value)) {
    if (value.length < 2) fail(path, '[x, y] or [x, y, z]');
    const x = requireFiniteNumber(value[0], `${path}[0]`);
    const y = requireFiniteNumber(value[1], `${path}[1]`);
    if (value.length < 3 || value[2] === undefined) {
      return { x, y };
    }
    return { x, y, z: requireFiniteNumber(value[2], `${path}[2]`) };
  }
  if (isRecord(value)) {
    const x = requireFiniteNumber(value['x'], `${path}.x`);
    const y = requireFiniteNumber(value['y'], `${path}.y`);
    if (value['z'] === undefined) {
      return { x, y };
    }
    return { x, y, z: requireFiniteNumber(value['z'], `${path}.z`) };
  }
  return fail(path, '[x, y] or { x, y }');
}

/** Parse a handedness classification in either the flat or nested form. */
function parseHandedness(hand: Record<string, unknown>, path: string): Handedness {
  const raw = hand['handedness'];
  if (isRecord(raw)) {
    const label = requireString(raw['label'], `${path}.handedness.label`);
    if (label !== 'Left' && label !== 'Right') {
      fail(`${path}.handedness.label`, '"Left" or "Right"');
    }
    return {
      label,
      score: requireFiniteNumber(raw['score'], `${path}.handedness.score`),
    };
  }
  const label = requireString(raw, `${path}.handedness`);
  if (label !== 'Left' && label !== 'Right') {
    fail(`${path}.handedness`, '"Left" or "Right"');
  }
  // The score is a model output, so a fixture must state it rather than have one
  // invented for it here (PLAN.md §5.1, §6.2).
  const score = requireFiniteNumber(
    hand['handednessScore'],
    `${path}.handednessScore`,
  );
  return { label: label as HandednessLabel, score };
}

function parseHand(value: unknown, path: string): RawHandFrame {
  if (!isRecord(value)) fail(path, 'an object');
  const landmarksRaw = value['landmarks'];
  if (!Array.isArray(landmarksRaw)) fail(`${path}.landmarks`, 'an array');
  if (landmarksRaw.length !== LANDMARK_COUNT) {
    fail(
      `${path}.landmarks`,
      `exactly ${LANDMARK_COUNT} entries, got ${landmarksRaw.length}`,
    );
  }
  const landmarks = landmarksRaw.map((entry, index) =>
    parseLandmark(entry, `${path}.landmarks[${index}]`),
  );
  return { landmarks, handedness: parseHandedness(value, path) };
}

function parseProvenance(value: unknown, path: string): FrameProvenance {
  if (value === undefined) return 'simulated';
  if (value === 'observed' || value === 'interpolated' || value === 'simulated') {
    return value;
  }
  return fail(path, '"observed", "interpolated" or "simulated"');
}

/**
 * Validate and normalize a parsed fixture.
 *
 * Throws {@link ReplayClipError} with a path-qualified message, so a malformed
 * fixture fails loudly at load instead of producing a subtly wrong hand later.
 */
export function parseReplayClip(input: unknown): ReplayClip {
  if (!isRecord(input)) fail('clip', 'an object');

  const name = requireString(input['name'], 'clip.name');
  const fps = requirePositiveNumber(input['fps'], 'clip.fps');

  const source = input['source'];
  if (!isRecord(source)) fail('clip.source', 'an object');
  const sourceWidth = requirePositiveNumber(source['width'], 'clip.source.width');
  const sourceHeight = requirePositiveNumber(source['height'], 'clip.source.height');

  const framesRaw = input['frames'];
  if (!Array.isArray(framesRaw)) fail('clip.frames', 'an array');
  if (framesRaw.length === 0) fail('clip.frames', 'at least one frame');

  const frames: ReplayFrame[] = framesRaw.map((frameValue, index) => {
    const path = `clip.frames[${index}]`;
    if (!isRecord(frameValue)) fail(path, 'an object');
    const timestampMs = requireFiniteNumber(frameValue['t'], `${path}.t`);
    const handsRaw = frameValue['hands'];
    if (!Array.isArray(handsRaw)) fail(`${path}.hands`, 'an array');
    return {
      timestampMs,
      hands: handsRaw.map((hand, handIndex) =>
        parseHand(hand, `${path}.hands[${handIndex}]`),
      ),
    };
  });

  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i]!.timestampMs < frames[i - 1]!.timestampMs) {
      fail(
        `clip.frames[${i}].t`,
        `a timestamp >= clip.frames[${i - 1}].t (${frames[i - 1]!.timestampMs})`,
      );
    }
  }

  const frameDurationMs = 1000 / fps;
  const last = frames[frames.length - 1]!;
  const durationMs = last.timestampMs + frameDurationMs;

  return {
    name,
    fps,
    sourceWidth,
    sourceHeight,
    frames,
    provenance: parseProvenance(input['provenance'], 'clip.provenance'),
    durationMs,
  };
}

export interface ReplaySourceOptions {
  /** Loop the clip when it reaches the end. Defaults to `REPLAY.loop`. */
  loop?: boolean;
}

/**
 * A `HandFrameSource` that replays a clip against the render loop's clock.
 *
 * "Emits frames on a timer" is realised by pulling: the render loop asks for the
 * frame at the current time, and the clip advances accordingly. That keeps the
 * harness free of its own timer, keeps replay deterministic in tests, and means
 * the replay path exercises the same render loop as the live one.
 */
export class ReplaySource implements HandFrameSource {
  readonly id = 'replay';
  readonly provenance: FrameProvenance;

  private readonly clip: ReplayClip;
  private readonly loop: boolean;
  private started = false;
  private startMs = 0;

  constructor(clip: ReplayClip, options: ReplaySourceOptions = {}) {
    this.clip = clip;
    this.provenance = clip.provenance;
    this.loop = options.loop ?? REPLAY.loop;
  }

  /** The validated clip, for diagnostics. */
  get clipInfo(): ReplayClip {
    return this.clip;
  }

  start(nowMs: number): void {
    this.started = true;
    this.startMs = nowMs;
  }

  stop(): void {
    this.started = false;
  }

  /** Index of the clip frame showing at `elapsedMs` (last frame at or before it). */
  frameIndexAt(elapsedMs: number): number {
    const frames = this.clip.frames;
    let low = 0;
    let high = frames.length - 1;
    let result = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (frames[mid]!.timestampMs <= elapsedMs) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  }

  frameAt(nowMs: number): RawFrame | null {
    if (!this.started) return null;

    let elapsedMs = nowMs - this.startMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = 0;

    if (this.loop) {
      elapsedMs %= this.clip.durationMs;
    } else if (elapsedMs >= this.clip.durationMs) {
      // Hold on the final frame rather than going blank.
      elapsedMs = this.clip.durationMs - Number.EPSILON;
    }

    const frame = this.clip.frames[this.frameIndexAt(elapsedMs)]!;

    return {
      // Always the render loop's clock, so `timestampMs` stays monotonic for
      // every source. The clip's own time is a replay detail.
      timestampMs: nowMs,
      // The array is copied so a consumer cannot reorder the clip; the landmark
      // arrays inside are shared and must be treated as immutable.
      hands: [...frame.hands],
      sourceId: this.id,
      provenance: this.provenance,
    };
  }
}
