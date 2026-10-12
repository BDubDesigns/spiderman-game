/**
 * Unit tests for the debug HUD's text.
 *
 * The important assertions here are negative ones: the HUD must not present any
 * value the codebase cannot measure. PLAN.md §7.2, §5.1 and §6.2 all forbid
 * showing an inference rate, a model confidence or a gesture score that does not
 * exist — this test makes that a build-time guarantee rather than a habit.
 */

import { describe, expect, it } from 'vitest';

import { formatHudLines, type HudStats } from './hud';

const stats: HudStats = {
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

describe('formatHudLines', () => {
  it('reports the source, render rate and drawing counts', () => {
    const text = formatHudLines(stats).join('\n');
    expect(text).toContain('mouse');
    expect(text).toContain('simulated');
    expect(text).toContain('59.9 fps');
    expect(text).toContain('16.7 ms');
    expect(text).toContain('hands 1');
    expect(text).toContain('dots 21');
    expect(text).toContain('updates 1200');
  });

  it('labels render FPS explicitly, since that is the measured success condition', () => {
    expect(formatHudLines(stats)[1]).toMatch(/render .* fps/);
  });

  it('never reports inference rate, model confidence or gesture score at M0', () => {
    const text = formatHudLines(stats).join('\n').toLowerCase();
    for (const forbidden of [
      'hz',
      'inference',
      'confidence',
      'gesturescore',
      'latency',
      'staleness',
      'identitymatchscore',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('emits one line per reported group and no NaN/Infinity text', () => {
    const lines = formatHudLines(stats);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toMatch(/NaN|Infinity/);
  });

  it('survives a zeroed stats object without printing NaN', () => {
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
  });
});
