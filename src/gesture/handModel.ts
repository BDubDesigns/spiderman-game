/**
 * Synthetic hand builder for tests and on-device diagnostics.
 *
 * **Not used at runtime.** It exists so the two pose classifiers can be compared on
 * *identical* geometry, and so adversarial poses (open palm, fist, pointing, partially
 * curled, foreshortened, mis-placed tip) can be constructed deliberately rather than
 * hunted for in a recording.
 *
 * ---- What this model is and is not ----
 *
 * The palm is a fixed schematic scaffold and each finger is a three-segment chain whose
 * PIP and DIP joints bend by an amount set by `curl`. So **the joint angles are exactly
 * what the caller asks for**, which is what makes it a sound instrument for the
 * joint-angle classifier.
 *
 * It is **not** an anatomical simulation, and two consequences are worth stating plainly
 * because tests depend on them:
 *
 * 1. Real finger flexion is largely *out of plane* (toward the camera), so a real curled
 *    finger foreshortens. Here it bends in the image plane. `foreshortening` injects the
 *    projected-length effect explicitly rather than pretending it is already there.
 * 2. A 2D chain cannot fold a fingertip back onto the palm the way a real finger does —
 *    that needs roughly 260 degrees of cumulative flexion. So `foldTipToPalm` places the
 *    tip where a real folded finger's tip actually is, instead of leaving it wherever the
 *    planar chain happens to end. Without it the distance classifier would be handed a
 *    hand no real hand resembles, and comparing the two classifiers would be meaningless.
 *
 * **Synthetic fixtures cannot validate real-hand accuracy.** They can only show that a
 * classifier does what it says on geometry whose joint angles are known. The real-hand
 * question is answered on the Pixel, via the capture tool.
 */

import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark, NormalizedPoint } from '../tracking/landmarkTypes';
import { DEFAULT_ASPECT, centroid, metricDistance } from './geometry';

/** A finger's three phalanx lengths, as a fraction of hand span. */
type Phalanges = readonly [number, number, number];

/**
 * Segment lengths as a fraction of hand span (wrist → middle MCP).
 *
 * Anatomically plausible: the middle finger is longest, the pinky considerably shorter.
 * Only the ratios matter, because every classifier threshold is a ratio.
 */
const PHALANGES: Readonly<Record<'index' | 'middle' | 'ring' | 'pinky', Phalanges>> = {
  index: [0.42, 0.26, 0.2],
  middle: [0.45, 0.28, 0.22],
  ring: [0.42, 0.26, 0.2],
  pinky: [0.3, 0.19, 0.15],
};

/** In-plane bend at the PIP and DIP when `curl` is 1, in degrees. */
const FULL_PIP_BEND_DEG = 100;
const FULL_DIP_BEND_DEG = 80;

/** How far from the palm centre a `foldTipToPalm` fingertip is placed. */
const FOLDED_TIP_FROM_PALM = 0.1;

/**
 * Schematic palm, with the wrist at the origin and the middle MCP one unit away, so
 * `wrist → middle MCP` is exactly 1 in metric units and every ratio in a test reads as
 * an absolute number.
 */
const WRIST: NormalizedPoint = { x: 0, y: 0 };
const MCP: Readonly<Record<'index' | 'middle' | 'ring' | 'pinky', NormalizedPoint>> = {
  index: { x: -0.3, y: 0.9 },
  middle: { x: 0, y: 1.0 },
  ring: { x: 0.3, y: 0.9 },
  pinky: { x: 0.6, y: 1.0 },
};

const PALM_CENTRE = centroid([WRIST, MCP.index, MCP.middle, MCP.ring, MCP.pinky]);

export interface FingerSpec {
  /** `0` = fully extended, `1` = bent as far as this planar chain goes. */
  curl: number;
  /**
   * Place the tip where a real folded fingertip lands — near the palm centre — instead
   * of at the end of the planar chain.
   *
   * A 2D chain cannot fold a tip onto the palm (that needs ~260 degrees of cumulative
   * flexion), so without this a "curled" finger's tip ends up off to the side and the
   * distance classifier is asked to judge a hand that could not exist surface. Set it
   * whenever the intent is "the finger is genuinely pressed to the palm".
   */
  foldTipToPalm?: boolean;
  /**
   * Place the tip at the end of a **straight** chain from the MCP, ignoring `curl`.
   *
   * This is the realistic formulation of the observed failure. MediaPipe under-observes
   * a flexed finger and estimates its tip roughly where an *extended* finger's tip would
   * be, which leaves the fingertip far from the palm while the PIP and DIP joints — which
   * are visible from the silhouette — are reported bent. The distance classifier's
   * fingertip-to-palm ratio then reads far outside `foldEnter`, which is exactly the
   * 0.7-1.6 against 0.35 that was measured on the device.
   */
  tipAsIfExtended?: boolean;
  /**
   * Displace the TIP landmark, in normalized units, after everything else.
   *
   * A raw lever for constructing specific geometry; `tipAsIfExtended` is the
   * realistic form and should be preferred where it fits.
   */
  tipDrift?: NormalizedPoint;
}

export interface HandSpec {
  index: FingerSpec;
  middle: FingerSpec;
  ring: FingerSpec;
  pinky: FingerSpec;
  /**
   * Scales every phalanx's projected length. `1` is a hand square-on to the camera;
   * small values are a hand pointing at the lens, where joint angles become
   * ill-conditioned.
   */
  foreshortening?: number;
}

/** A rotation, in screen coordinates where `+y` is down. */
function rotate(dx: number, dy: number, degrees: number): { dx: number; dy: number } {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { dx: dx * cos - dy * sin, dy: dx * sin + dy * cos };
}

/**
 * Which way a finger of this hand bends in the image plane so its tip travels toward the
 * palm centre rather than away from it.
 *
 * Fingers on opposite sides of the palm bend in opposite screen directions, so this is
 * derived rather than hard-coded.
 */
function bendSign(mcp: NormalizedPoint): number {
  // The finger axis points away from the wrist, i.e. along +y in this scaffold.
  const axis = { dx: 0, dy: 1 };
  const toPalm = { dx: PALM_CENTRE.x - mcp.x, dy: PALM_CENTRE.y - mcp.y };
  const cross = axis.dx * toPalm.dy - axis.dy * toPalm.dx;
  return cross >= 0 ? 1 : -1;
}

function buildChain(
  name: 'index' | 'middle' | 'ring' | 'pinky',
  spec: FingerSpec,
  foreshortening: number,
): NormalizedPoint[] {
  const mcp = MCP[name];
  const lengths = PHALANGES[name];
  const l1 = lengths[0] * foreshortening;
  const l2 = lengths[1] * foreshortening;
  const l3 = lengths[2] * foreshortening;
  const curl = Math.min(1, Math.max(0, spec.curl));
  const sign = bendSign(mcp);

  // Fingers extend away from the wrist, so the tip of a straight finger is further from
  // the wrist than the MCP is — which is what the distance classifier's extension check
  // needs, and what a real hand does.
  const d1 = { dx: 0, dy: 1 };
  const d2 = rotate(d1.dx, d1.dy, sign * curl * FULL_PIP_BEND_DEG);
  const d3 = rotate(d2.dx, d2.dy, sign * curl * FULL_DIP_BEND_DEG);

  const pip: NormalizedPoint = { x: mcp.x + d1.dx * l1, y: mcp.y + d1.dy * l1 };
  const dip: NormalizedPoint = { x: pip.x + d2.dx * l2, y: pip.y + d2.dy * l2 };
  const driven: NormalizedPoint = { x: dip.x + d3.dx * l3, y: dip.y + d3.dy * l3 };

  let tip = driven;
  if (spec.foldTipToPalm === true) {
    // Put the tip where a real folded fingertip is: near the palm centre, on the side
    // the finger curled toward.
    const dx = dip.x - PALM_CENTRE.x;
    const dy = dip.y - PALM_CENTRE.y;
    const length = Math.hypot(dx, dy);
    const unit = length > 1e-9 ? { dx: dx / length, dy: dy / length } : { dx: 0, dy: -1 };
    tip = {
      x: PALM_CENTRE.x + unit.dx * FOLDED_TIP_FROM_PALM,
      y: PALM_CENTRE.y + unit.dy * FOLDED_TIP_FROM_PALM,
    };
  }

  if (spec.tipAsIfExtended === true) {
    // Along the unbent chain: the extension prior the model applies under occlusion.
    tip = { x: mcp.x + d1.dx * (l1 + l2 + l3), y: mcp.y + d1.dy * (l1 + l2 + l3) };
  }

  const drift = spec.tipDrift ?? { x: 0, y: 0 };
  return [mcp, pip, dip, { x: tip.x + drift.x, y: tip.y + drift.y }];
}

/** Build a 21-landmark hand in the normalized video space MediaPipe uses. */
export function buildHand(spec: HandSpec): NormalizedLandmark[] {
  const foreshortening = spec.foreshortening ?? 1;
  const points: NormalizedPoint[] = Array.from({ length: 21 }, () => ({ ...WRIST }));

  points[Landmark.WRIST] = { ...WRIST };
  points[Landmark.INDEX_MCP] = { ...MCP.index };
  points[Landmark.MIDDLE_MCP] = { ...MCP.middle };
  points[Landmark.RING_MCP] = { ...MCP.ring };
  points[Landmark.PINKY_MCP] = { ...MCP.pinky };

  // `start` is the PIP index; MediaPipe numbers each chain MCP, PIP, DIP, TIP.
  const chains: Array<[number, 'index' | 'middle' | 'ring' | 'pinky', FingerSpec]> = [
    [Landmark.INDEX_PIP, 'index', spec.index],
    [Landmark.MIDDLE_PIP, 'middle', spec.middle],
    [Landmark.RING_PIP, 'ring', spec.ring],
    [Landmark.PINKY_PIP, 'pinky', spec.pinky],
  ];

  for (const [start, name, fingerSpec] of chains) {
    const chain = buildChain(name, fingerSpec, foreshortening);
    points[start] = chain[1]!;
    points[start + 1] = chain[2]!;
    points[start + 2] = chain[3]!;
    points[start - 1] = chain[0]!;
  }

  return points.map((point) => ({ x: point.x, y: point.y }));
}

/** The gesture: middle and ring pressed to the palm, index and pinky extended. */
export const GESTURE_SPEC: HandSpec = {
  index: { curl: 0 },
  middle: { curl: 1, foldTipToPalm: true },
  ring: { curl: 1, foldTipToPalm: true },
  pinky: { curl: 0 },
};

/** An open, flat hand. */
export const OPEN_PALM_SPEC: HandSpec = {
  index: { curl: 0 },
  middle: { curl: 0 },
  ring: { curl: 0 },
  pinky: { curl: 0 },
};

/** A fist: every finger folded. Must never read as the gesture. */
export const FIST_SPEC: HandSpec = {
  index: { curl: 1, foldTipToPalm: true },
  middle: { curl: 1, foldTipToPalm: true },
  ring: { curl: 1, foldTipToPalm: true },
  pinky: { curl: 1, foldTipToPalm: true },
};

/** Index extended, everything else folded. Must never read as the gesture. */
export const POINTING_SPEC: HandSpec = {
  index: { curl: 0 },
  middle: { curl: 1, foldTipToPalm: true },
  ring: { curl: 1, foldTipToPalm: true },
  pinky: { curl: 1, foldTipToPalm: true },
};

/** A loosely relaxed hand: part-curled everywhere, nothing deliberate, tip not folded in. */
export const RELAXED_SPEC: HandSpec = {
  index: { curl: 0.45 },
  middle: { curl: 0.5 },
  ring: { curl: 0.5 },
  pinky: { curl: 0.45 },
};

/**
 * The gesture as MediaPipe may report it: the joints bent as they really are, but the
 * fingertip estimated along an extended-curl prior, far from the palm.
 *
 * This reproduces the observed device failure — middle/ring fingertip-to-palm well
 * outside `foldEnter` — without touching the joints.
 */
export const GESTURE_MISPLACED_TIP_SPEC: HandSpec = {
  index: { curl: 0 },
  middle: { curl: 1, tipAsIfExtended: true },
  ring: { curl: 1, tipAsIfExtended: true },
  pinky: { curl: 0 },
};

/** Hand span in metric units, for callers that need the normalizer. */
export function spanOfHand(
  landmarks: readonly NormalizedLandmark[],
  aspect = DEFAULT_ASPECT,
): number {
  const wrist = landmarks[Landmark.WRIST];
  const mcp = landmarks[Landmark.MIDDLE_MCP];
  if (!wrist || !mcp) return 0;
  return metricDistance(wrist, mcp, aspect);
}

/** The palm centre this model's fingers bend toward, exposed for assertions. */
export const PALM_CENTRE_OF_MODEL = PALM_CENTRE;

/**
 * Re-express a hand as it would appear at a different capture aspect.
 *
 * MediaPipe normalizes each axis by its own image dimension, so **the same physical hand
 * produces different normalized numbers in portrait and landscape**. This converts
 * through metric space so a test can hold the physical hand fixed and vary only the
 * aspect — the only honest way to test that a classifier is aspect-invariant.
 */
export function reproject(
  landmarks: readonly NormalizedLandmark[],
  fromAspect: number,
  toAspect: number,
): NormalizedLandmark[] {
  return landmarks.map((point) => ({
    x: (point.x * fromAspect) / toAspect,
    y: point.y,
  }));
}
