/**
 * Targets (PLAN.md §12.3).
 *
 * A target field of N static targets. Positions are normalized video space, so the
 * same field works at any capture resolution and the renderer's existing
 * `toCanvas()` handles the mirroring — §8 Rule B says mirroring happens in exactly
 * one place, and a game system must not add a second.
 *
 * Spawn placement is **deterministic from a seed**. That is what makes "the
 * simulator can fire at a target" a test rather than a screenshot: a test can place
 * a target, aim at it, and assert the hit.
 *
 * No scoring lives here. Alternating hands and scoring are M4 (§12.4); M3 is
 * targets, webs and the webbed/inert state.
 */

import { TARGETS } from '../config';
import type { NormalizedPoint } from '../tracking/landmarkTypes';

/** A target's lifecycle state. `webbed` means hit and inert (§12.2). */
export type TargetState = 'active' | 'webbed';

export interface Target {
  id: number;
  /** Center, in normalized video space. */
  center: NormalizedPoint;
  /** Radius as a fraction of the shorter source side. */
  radius: number;
  state: TargetState;
  /** Monotonic id of the web that webbed it, for rendering the overlay. */
  webbedBy: number | null;
  /** When it was webbed, on the caller's clock. */
  webbedAtMs: number | null;
}

/** A small deterministic PRNG, so a seed reproduces a field exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How far apart two targets are, in normalized units, given the source aspect. */
export function normalizedDistance(
  a: NormalizedPoint,
  b: NormalizedPoint,
  aspect: number,
): number {
  // x is in width units and y in height units, so scale x by the aspect ratio to
  // compare like with like.
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

export interface TargetFieldOptions {
  /** Source aspect (width / height), used only for spacing and radius. */
  aspect?: number;
  count?: number;
  seed?: number;
}

/**
 * A set of targets to clear.
 *
 * `hitTest` is deliberately a distance test against the target's own radius rather
 * than a pixel test: §12.1's auto-aim already chose the target, and re-deciding the
 * hit by geometry would make the reticle a lie.
 */
export class TargetField {
  private targets: Target[] = [];
  private nextId = 1;
  private readonly aspect: number;
  private readonly count: number;

  constructor(options: TargetFieldOptions = {}) {
    this.aspect = options.aspect ?? 4 / 3;
    this.count = options.count ?? TARGETS.perRound;
    this.spawn(options.seed ?? 0);
  }

  /** All targets, stable order by id. */
  all(): readonly Target[] {
    return this.targets;
  }

  /** Targets not yet webbed. */
  active(): Target[] {
    return this.targets.filter((target) => target.state === 'active');
  }

  /** Targets already webbed. */
  webbed(): Target[] {
    return this.targets.filter((target) => target.state === 'webbed');
  }

  /** Every target has been webbed — the §12.3 clear condition, without scoring. */
  get cleared(): boolean {
    return this.targets.length > 0 && this.targets.every((t) => t.state === 'webbed');
  }

  get remaining(): number {
    return this.targets.reduce((n, t) => (t.state === 'active' ? n + 1 : n), 0);
  }

  /**
   * Rebuild the field. Deterministic for a given seed, which is what lets a test
   * (or a replay) put a target where it expects one.
   */
  spawn(seed = 0): void {
    const random = mulberry32(seed);
    const margin = TARGETS.marginFraction;
    const minSeparation = TARGETS.minSeparationFraction;
    const placed: Target[] = [];
    this.nextId = 1;

    let guard = 0;
    while (placed.length < this.count && guard < this.count * 200) {
      guard += 1;
      const candidate: NormalizedPoint = {
        x: margin + random() * (1 - margin * 2),
        y: margin + random() * (1 - margin * 2),
      };
      const tooClose = placed.some(
        (target) => normalizedDistance(target.center, candidate, this.aspect) < minSeparation,
      );
      if (tooClose) continue;

      placed.push({
        id: this.nextId,
        center: candidate,
        radius: TARGETS.radiusFraction,
        state: 'active',
        webbedBy: null,
        webbedAtMs: null,
      });
      this.nextId += 1;
    }

    // If the spacing floor could not be met, take what was found rather than
    // looping forever; a slightly tighter field beats no field.
    this.targets = placed;
  }

  /** The target with this id, or `null`. */
  find(id: number): Target | null {
    return this.targets.find((target) => target.id === id) ?? null;
  }

  /**
   * Whether `point` lands on `target`.
   *
   * The radius is a fraction of the shorter source side, so a target covers the
   * same visual area at any resolution.
   */
  static contains(target: Target, point: NormalizedPoint, aspect = 4 / 3): boolean {
    return normalizedDistance(target.center, point, aspect) <= target.radius;
  }

  /** True when the point lands on this target. */
  contains(target: Target, point: NormalizedPoint): boolean {
    return TargetField.contains(target, point, this.aspect);
  }

  /**
   * Web a target. Returns the updated target, or `null` when it was already
   * webbed — an already-inert target must not be consumed twice (§12.2).
   */
  web(targetId: number, webId: number, atMs: number): Target | null {
    const target = this.find(targetId);
    if (target === null || target.state === 'webbed') return null;
    target.state = 'webbed';
    target.webbedBy = webId;
    target.webbedAtMs = atMs;
    return target;
  }
}
