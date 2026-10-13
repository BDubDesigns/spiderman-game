/**
 * The interactive hand simulator (PLAN.md §13 M0, §21.5).
 *
 * **This is not a game.** It produces a plausible synthetic 21-landmark hand
 * driven by a pointer. Its purpose is to be the permanent, playable fallback
 * once M3/M4 gameplay systems exist (PLAN.md §13 M0, §16.3) and to let the whole
 * render pipeline be developed and tested with no camera at all.
 *
 * To be a real fallback rather than a demo, it satisfies the exact same
 * `HandFrameSource` contract that the M1 camera tracker will, so game code
 * cannot tell them apart.
 *
 * ---- Purity (PLAN.md §6.1) ----
 *
 * This module has no DOM, no canvas, and no MediaPipe types. The pointer arrives
 * as a normalized point; `main.ts` owns the DOM listeners and does the one
 * required canvas -> normalized conversion. The hand is authored in pixel space
 * (canvas space is the game's space, §8 Rule E) and normalized on output, so
 * `toCanvas()` remains the only normalized -> canvas conversion in the codebase.
 *
 * ---- Geometry ----
 *
 * Landmarks are laid out in hand-span units, where 1 unit is the wrist(0) ->
 * middle-MCP(9) distance — the same normalization the real gesture math uses
 * (PLAN.md §11.1), so the simulator behaves sensibly for both adult and child
 * hand sizes as the span changes.
 *
 * `curl` interpolates the middle and ring chains from extended to folded. Those
 * are precisely the fingers the web gesture folds (§11.1), so at `curl = 1` the
 * simulator produces the web-gesture pose and at `curl = 0` an open hand. M0
 * does not classify anything; this only guarantees the simulator can *produce*
 * poses worth classifying in M2.
 */

import { SIM } from '../config';
import {
  LANDMARK_COUNT,
  Landmark,
  type FrameProvenance,
  type HandFrameSource,
  type HandednessLabel,
  type NormalizedLandmark,
  type NormalizedPoint,
  type RawFrame,
  type RawHandFrame,
} from '../tracking/landmarkTypes';

/** A point in normalized video space (PLAN.md §8). Re-exported from the shared
 *  definition in `tracking/landmarkTypes.ts` so `sim/` and `tracking/` cannot
 *  drift apart or define two competing notions of "normalized point". */
export type { NormalizedPoint };

/** A landmark offset in hand-span units; +x is the thumb side, -y is distal. */
type HandPoint = readonly [number, number];

/**
 * Open-hand landmark offsets, wrist at the origin, fingers toward -y (video
 * space grows downward). Values are hand-span units, chosen to be anatomically
 * plausible rather than measured — this is a simulator, not a model.
 *
 * Indices 0/5/9/13/17 (wrist + MCPs) define the palm centroid, matching the
 * definition in PLAN.md §11.1.
 */
const OPEN_HAND: readonly HandPoint[] = [
  [0, 0], // 0  WRIST
  [-0.5, -0.35], // 1  THUMB_CMC
  [-0.78, -0.62], // 2  THUMB_MCP
  [-0.95, -0.85], // 3  THUMB_IP
  [-1.05, -1.05], // 4  THUMB_TIP
  [-0.35, -0.87], // 5  INDEX_MCP
  [-0.38, -1.35], // 6  INDEX_PIP
  [-0.4, -1.6], // 7  INDEX_DIP
  [-0.41, -1.8], // 8  INDEX_TIP
  [0, -1.0], // 9  MIDDLE_MCP
  [0, -1.5], // 10 MIDDLE_PIP   (folded by curl)
  [0, -1.75], // 11 MIDDLE_DIP   (folded by curl)
  [0, -1.95], // 12 MIDDLE_TIP   (folded by curl)
  [0.32, -0.94], // 13 RING_MCP
  [0.33, -1.4], // 14 RING_PIP     (folded by curl)
  [0.34, -1.65], // 15 RING_DIP     (folded by curl)
  [0.35, -1.83], // 16 RING_TIP     (folded by curl)
  [0.6, -0.78], // 17 PINKY_MCP
  [0.62, -1.2], // 18 PINKY_PIP
  [0.64, -1.4], // 19 PINKY_DIP
  [0.66, -1.55], // 20 PINKY_TIP
];

/** Middle finger folded: the tip comes back to the palm. */
const MIDDLE_FOLDED: readonly HandPoint[] = [
  [0, -1.42],
  [0, -1.1],
  [0.02, -0.85],
];

/** Ring finger folded: the tip comes back to the palm. */
const RING_FOLDED: readonly HandPoint[] = [
  [0.33, -1.33],
  [0.34, -1.06],
  [0.35, -0.82],
];

/** Landmarks whose centroid defines the palm (PLAN.md §11.1). */
const PALM_LANDMARKS = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

/** Wrist and middle MCP: the span that normalizes every other measurement. */
export const SPAN_LANDMARKS = [Landmark.WRIST, Landmark.MIDDLE_MCP] as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Linear interpolation of a finger chain toward its folded pose. */
function foldChain(
  points: Array<[number, number]>,
  indices: readonly number[],
  targets: readonly HandPoint[],
  curl: number,
): void {
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i]!;
    const target = targets[i]!;
    const from = points[index]!;
    from[0] += (target[0] - from[0]) * curl;
    from[1] += (target[1] - from[1]) * curl;
  }
}

/**
 * The hand template at a given curl.
 *
 * Exported for tests, which assert that the simulator can actually produce a
 * folded pose without M0 having to implement a classifier that belongs to M2.
 */
export function handTemplateAtCurl(curl: number): ReadonlyArray<HandPoint> {
  const c = clamp01(curl);
  const points: Array<[number, number]> = OPEN_HAND.map(([x, y]) => [x, y]);
  foldChain(
    points,
    [Landmark.MIDDLE_PIP, Landmark.MIDDLE_DIP, Landmark.MIDDLE_TIP],
    MIDDLE_FOLDED,
    c,
  );
  foldChain(
    points,
    [Landmark.RING_PIP, Landmark.RING_DIP, Landmark.RING_TIP],
    RING_FOLDED,
    c,
  );
  return points;
}

export interface SyntheticHandOptions {
  /** Where the palm centroid should land, in normalized video space. */
  palm: NormalizedPoint;
  /** Source intrinsic width in px, for aspect correction (PLAN.md §8 Rule A). */
  sourceWidthPx: number;
  /** Source intrinsic height in px, for aspect correction. */
  sourceHeightPx: number;
  /** Wrist -> middle MCP distance, in px. */
  spanPx: number;
  /** 0 = open hand, 1 = fully folded web gesture. */
  curl: number;
  /** Roll about the palm, in radians. */
  rollRad: number;
  handedness: HandednessLabel;
  /** Handedness score to report. A model output; the simulator just states one. */
  handednessScore: number;
}

/**
 * Build one synthetic hand.
 *
 * Order of operations matters: the hand is placed in **pixel** space first and
 * only then normalized. Rotating in normalized space would shear the hand
 * whenever the source is non-square, because normalized x and y have different
 * pixel scales.
 *
 * The palm (not the wrist) is placed on `palm`, so the hand sits under the
 * pointer rather than hanging off it.
 */
export function buildSyntheticHand(options: SyntheticHandOptions): RawHandFrame {
  const {
    palm,
    sourceWidthPx,
    sourceHeightPx,
    spanPx,
    curl,
    rollRad,
    handedness,
    handednessScore,
  } = options;

  if (!(sourceWidthPx > 0) || !(sourceHeightPx > 0)) {
    throw new RangeError(
      `source dimensions must be positive, got ${sourceWidthPx}x${sourceHeightPx}`,
    );
  }
  if (!(spanPx > 0)) {
    throw new RangeError(`spanPx must be positive, got ${spanPx}`);
  }

  const template = handTemplateAtCurl(curl);
  const cos = Math.cos(rollRad);
  const sin = Math.sin(rollRad);
  /** A true reflection of the finished shape, which is what a left hand is. */
  const mirror = handedness === 'Left' ? -1 : 1;

  // Hand-span units -> px -> roll -> mirror. y already grows downward in both
  // video space and canvas space, so no flip is needed here.
  const pixelPoints = template.map(([tx, ty]) => {
    const px = tx * spanPx;
    const py = ty * spanPx;
    return {
      x: mirror * (px * cos - py * sin),
      y: px * sin + py * cos,
    };
  });

  // Place the palm centroid exactly on the requested anchor.
  let centroidX = 0;
  let centroidY = 0;
  for (const index of PALM_LANDMARKS) {
    centroidX += pixelPoints[index]!.x;
    centroidY += pixelPoints[index]!.y;
  }
  centroidX /= PALM_LANDMARKS.length;
  centroidY /= PALM_LANDMARKS.length;

  const offsetX = palm.x * sourceWidthPx - centroidX;
  const offsetY = palm.y * sourceHeightPx - centroidY;

  const landmarks: NormalizedLandmark[] = pixelPoints.map((point) => ({
    x: (point.x + offsetX) / sourceWidthPx,
    y: (point.y + offsetY) / sourceHeightPx,
  }));

  if (landmarks.length !== LANDMARK_COUNT) {
    // Unreachable unless the template above is edited incorrectly.
    throw new Error(
      `synthetic hand template must have ${LANDMARK_COUNT} points, got ${landmarks.length}`,
    );
  }

  return { landmarks, handedness: { label: handedness, score: handednessScore } };
}

/**
 * Keep the palm inside the source, leaving `marginPx` of slack.
 *
 * Deliberately clamps the palm, not the whole hand: clamping the full hand would
 * make the hand stop following the pointer near an edge, which reads as a bug.
 * Fingers may therefore leave the frame at the edges. That is a simulator
 * limitation, not a tracking behavior.
 */
export function clampPalmToSource(
  palm: NormalizedPoint,
  sourceWidthPx: number,
  sourceHeightPx: number,
  marginPx: number,
): NormalizedPoint {
  const marginX = Math.min(marginPx / sourceWidthPx, 0.5);
  const marginY = Math.min(marginPx / sourceHeightPx, 0.5);
  const lo = (margin: number) => Math.min(margin, 0.5);
  const hi = (margin: number) => Math.max(1 - margin, 0.5);
  return {
    x: Math.min(Math.max(palm.x, lo(marginX)), hi(marginX)),
    y: Math.min(Math.max(palm.y, lo(marginY)), hi(marginY)),
  };
}

export interface MouseSourceOptions {
  /** Source intrinsic size, i.e. the canvas backing store (PLAN.md §8 Rule A). */
  sourceWidthPx: number;
  sourceHeightPx: number;
  spanPx?: number;
  palmMarginPx?: number;
  curlMs?: number;
  wobbleDeg?: number;
  wobbleMs?: number;
  handednessScore?: number;
  initialHandedness?: HandednessLabel;
}

/**
 * A pointer-driven `HandFrameSource`.
 *
 * Pointer input is pushed in with {@link MouseSource.setPointer}; frames are
 * pulled out with `frameAt()`. `main.ts` owns the DOM events and the
 * canvas -> normalized conversion, which keeps this class pure and testable.
 */
export class MouseSource implements HandFrameSource {
  readonly id = 'mouse';
  readonly provenance: FrameProvenance = 'simulated';

  private readonly sourceWidthPx: number;
  private readonly sourceHeightPx: number;
  private readonly spanPx: number;
  private readonly palmMarginPx: number;
  private readonly curlMs: number;
  private readonly wobbleDeg: number;
  private readonly wobbleMs: number;
  private readonly handednessScore: number;

  private pointer: NormalizedPoint = { x: 0.5, y: 0.5 };
  private pressed = false;
  private curl = 0;
  private hand: HandednessLabel;
  private started = false;
  private lastMs = 0;
  private startMs = 0;

  constructor(options: MouseSourceOptions) {
    this.sourceWidthPx = options.sourceWidthPx;
    this.sourceHeightPx = options.sourceHeightPx;
    this.spanPx = options.spanPx ?? SIM.handSpanPx;
    this.palmMarginPx = options.palmMarginPx ?? SIM.palmMarginPx;
    this.curlMs = options.curlMs ?? SIM.curlMs;
    this.wobbleDeg = options.wobbleDeg ?? SIM.wobbleDeg;
    this.wobbleMs = options.wobbleMs ?? SIM.wobbleMs;
    this.handednessScore = options.handednessScore ?? SIM.handednessScore;
    this.hand = options.initialHandedness ?? SIM.defaultHandedness;

    if (!(this.sourceWidthPx > 0) || !(this.sourceHeightPx > 0)) {
      throw new RangeError(
        `source dimensions must be positive, got ${this.sourceWidthPx}x${this.sourceHeightPx}`,
      );
    }
    if (!(this.wobbleMs > 0)) {
      throw new RangeError(`wobbleMs must be positive, got ${this.wobbleMs}`);
    }
  }

  /** Current handedness label the simulator reports. */
  get handedness(): HandednessLabel {
    return this.hand;
  }

  /** Whether the pointer is currently down (which folds the web gesture). */
  get isPressed(): boolean {
    return this.pressed;
  }

  /** Current finger curl, `[0,1]` — the simulator's own animation state. */
  get currentCurl(): number {
    return this.curl;
  }

  /** Current (unclamped) pointer position in normalized video space. */
  get pointerPosition(): NormalizedPoint {
    return { ...this.pointer };
  }

  /**
   * Update the pointer. `normalized` is in **video** space, i.e. already passed
   * through the inverse of `toCanvas()` by the caller (PLAN.md §8 Rule E).
   */
  setPointer(normalized: NormalizedPoint, pressed?: boolean): void {
    if (Number.isFinite(normalized.x) && Number.isFinite(normalized.y)) {
      this.pointer = { x: normalized.x, y: normalized.y };
    }
    if (pressed !== undefined) {
      this.pressed = pressed;
    }
  }

  /** Set the pressed state without moving the pointer (pointerup/pointercancel). */
  setPressed(pressed: boolean): void {
    this.pressed = pressed;
  }

  /** Flip which hand the simulator reports. Returns the new label. */
  toggleHandedness(): HandednessLabel {
    this.hand = this.hand === 'Right' ? 'Left' : 'Right';
    return this.hand;
  }

  start(nowMs: number): void {
    this.started = true;
    this.lastMs = nowMs;
    this.startMs = nowMs;
    this.curl = 0;
  }

  stop(): void {
    this.started = false;
  }

  frameAt(nowMs: number): RawFrame | null {
    if (!this.started) return null;

    // Advance the curl animation by real elapsed time, so the fold takes the
    // configured duration regardless of render rate.
    const elapsedMs = Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    const target = this.pressed ? 1 : 0;
    const maxStep = this.curlMs > 0 ? elapsedMs / this.curlMs : 1;
    const delta = target - this.curl;
    this.curl += Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;

    const palm = clampPalmToSource(
      this.pointer,
      this.sourceWidthPx,
      this.sourceHeightPx,
      this.palmMarginPx,
    );

    const wobble =
      this.wobbleDeg *
      Math.sin((2 * Math.PI * (nowMs - this.startMs)) / this.wobbleMs);

    const hand = buildSyntheticHand({
      palm,
      sourceWidthPx: this.sourceWidthPx,
      sourceHeightPx: this.sourceHeightPx,
      spanPx: this.spanPx,
      curl: this.curl,
      rollRad: degToRad(wobble),
      handedness: this.hand,
      handednessScore: this.handednessScore,
    });

    return {
      timestampMs: nowMs,
      hands: [hand],
      sourceId: this.id,
      provenance: this.provenance,
    };
  }
}
