/**
 * Unit tests for the debug HUD's text.
 *
 * The important assertions are the discipline ones. PLAN.md §5.1, §6.2, §7.2 and
 * §10.4 all forbid presenting a value the codebase cannot measure, and §7.2
 * requires measured inference to be labelled as measured. This test makes both a
 * build-time guarantee rather than a habit.
 */

import { describe, expect, it } from 'vitest';

import { formatHudLines, type HudStats } from './hud';

const baseStats: HudStats = {
  sourceId: 'mouse',
  provenance: 'simulated',
  fps: 59.94,
  lastFrameMs: 16.68,
  droppedMs: 0,
  updateSteps: 1200,
  alpha: 0.42,
  handCount: 1,
  dotsDrawn: 21,
};

const cameraStats: HudStats = {
  ...baseStats,
  sourceId: 'camera',
  provenance: 'observed',
  inference: {
    hz: 18.4,
    lastCostMs: 21.2,
    predictedCostMs: 24.9,
    frameBudgetMs: 16.7,
    runs: 240,
    skipsOverBudget: 61,
    forcedRuns: 3,
  },
  source: {
    framesSinceDetection: 2,
    msSinceDetection: 84,
    isStale: false,
    interpolated: false,
    crossings: 4,
    losses: 1,
    reacquisitions: 1,
    handednessConflicts: 0,
    inCrossing: false,
    frameClock: 'video-frame',
    backendKind: 'worker',
  },
};

describe('formatHudLines', () => {
  it('reports the source, render rate and drawing counts', () => {
    const text = formatHudLines(baseStats).join('\n');
    expect(text).toContain('mouse');
    expect(text).toContain('simulated');
    expect(text).toContain('59.9 fps');
    expect(text).toContain('16.7 ms');
    expect(text).toContain('hands 1');
    expect(text).toContain('dots 21');
    expect(text).toContain('updates 1200');
  });

  it('labels render FPS explicitly, since that is the measured success condition', () => {
    expect(formatHudLines(baseStats)[1]).toMatch(/render .* fps/);
  });

  it('says so plainly when no detector is running rather than showing a zero', () => {
    expect(formatHudLines(baseStats).join('\n')).toContain('inference not running');
  });

  it('labels measured inference frequency as measured (§7.2)', () => {
    const text = formatHudLines(cameraStats).join('\n');
    expect(text).toMatch(/inference 18\.4 Hz \(measured\)/);
    expect(text).toContain('call 21.2 ms');
    expect(text).toContain('budget');
  });

  it('reports the render-vs-inference decoupling figures the scheduler used', () => {
    const text = formatHudLines(cameraStats).join('\n');
    expect(text).toContain('runs 240');
    expect(text).toContain('skipped-over-budget 61');
    expect(text).toContain('forced-by-floor 3');
  });

  it('reports detection freshness and the interpolated-frame count explicitly', () => {
    const text = formatHudLines(cameraStats).join('\n');
    expect(text).toContain('detection age 84.0 ms (current)');
    expect(text).toContain('renders since detection 2');
    // §7.2: the count must be visible, and M1 does not extrapolate, so it is zero.
    expect(text).toContain('interpolated frames none');
  });

  it('marks a stale hand as stale rather than letting it look current', () => {
    const stale: HudStats = {
      ...cameraStats,
      source: { ...cameraStats.source!, isStale: true, msSinceDetection: 900 },
    };
    expect(formatHudLines(stale).join('\n')).toContain('(STALE)');
  });

  it('reports identity diagnostics as counted events, and flags an active crossing', () => {
    const text = formatHudLines(cameraStats).join('\n');
    expect(text).toContain('crossings 4');
    expect(text).toContain('losses 1');
    expect(text).toContain('reacquired 1');
    expect(text).toContain('handedness conflicts 0');

    const crossing: HudStats = {
      ...cameraStats,
      source: { ...cameraStats.source!, inCrossing: true },
    };
    expect(formatHudLines(crossing).join('\n')).toContain('(crossing now)');
  });

  it('surfaces a stalling detector instead of hiding it behind the retry policy', () => {
    const withoutFailures = formatHudLines(cameraStats).join('\n');
    expect(withoutFailures).not.toContain('detector failures');

    const stalling: HudStats = {
      ...cameraStats,
      source: { ...cameraStats.source!, consecutiveDetectFailures: 3 },
    };
    expect(formatHudLines(stalling).join('\n')).toContain('detector failures 3 consecutive');
  });

  it('reports which API is clocking inference, and where detection runs', () => {
    const text = formatHudLines(cameraStats).join('\n');
    expect(text).toContain('frame clock video-frame');
    // The A/B is meaningless without this: the same numbers mean different things on
    // the main thread and in a worker.
    expect(text).toContain('detection worker');
  });

  it('never uses the word confidence, because the model exposes none (§5.1)', () => {
    for (const stats of [baseStats, cameraStats]) {
      expect(formatHudLines(stats).join('\n').toLowerCase()).not.toContain('confidence');
    }
  });

  it('never labels a computed heuristic as a model output', () => {
    // identityMatchScore and staleness are game-computed (§6.2, §10.4). The HUD may
    // show staleness as an age; it must not present either as a model value.
    const text = formatHudLines(cameraStats).join('\n').toLowerCase();
    expect(text).not.toContain('model confidence');
    expect(text).not.toContain('identitymatchscore');
  });

  it('emits no NaN or Infinity text even from an all-zero or infinite state', () => {
    const zeroed: HudStats = {
      sourceId: 'replay',
      provenance: 'simulated',
      fps: 0,
      lastFrameMs: 0,
      droppedMs: 0,
      updateSteps: 0,
      alpha: 0,
      handCount: 0,
      dotsDrawn: 0,
    };
    expect(formatHudLines(zeroed).join('\n')).not.toMatch(/NaN|Infinity/);

    const noDetectionYet: HudStats = {
      ...cameraStats,
      source: {
        ...cameraStats.source!,
        msSinceDetection: Number.POSITIVE_INFINITY,
        isStale: true,
      },
    };
    expect(formatHudLines(noDetectionYet).join('\n')).not.toMatch(/NaN|Infinity/);
  });
});
