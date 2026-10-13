/**
 * Wiring test: the event-to-shot path is actually connected (PLAN.md §12.1).
 *
 * Requested by review on PR #12, and the request was precise: *"the synthetic cadence test by
 * itself did not exercise `main.ts`'s event dispatch."* Correct — and that is exactly why a
 * blocking bug shipped. `GestureController` was driven perfectly, every unit test passed, and
 * the camera's gesture events were consumed by a counter and never turned into a shot, because
 * the only `game.fire()` call sat in the render loop and camera render frames carry no events.
 *
 * A unit test of `fireDispatch` cannot catch that: it tests the function, not whether anything
 * calls it. So this file asserts the **wiring** by reading the source. That is unusual, and it
 * is the only honest way to lock this class of defect — "a path exists but nothing dispatches
 * from it" is invisible to every behavioural test of the parts.
 *
 * Deliberately narrow: it checks the specific structural facts that shipped a bug, not the shape
 * of `main.ts` in general.
 */

import { describe, expect, it } from 'vitest';

// Vite's `?raw` inlines the file as a string. Chosen over `node:fs` deliberately: this project's
// `tsconfig` ships `types: ["vite/client"]` and no `@types/node`, and adding a dependency for a
// single test would violate the dependency policy in `PLAN.md` §16.2.
import mainSource from '../main.ts?raw';
import dispatchSource from './fireDispatch.ts?raw';
import captureSource from '../debug/capture.ts?raw';
import panelSource from '../debug/capturePanel.ts?raw';
import pageSource from '../../index.html?raw';

/**
 * Source with comments removed.
 *
 * Needed because a comment that *mentions* `game.fire()` must not be mistaken for a call to it —
 * a mistake this file made on its first run, when the prose documenting the bug tripped the
 * assertion about the bug.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const mainCode = stripComments(mainSource);
const dispatchCode = stripComments(dispatchSource);
const captureCode = stripComments(captureSource);
const panelCode = stripComments(panelSource);
/** The page is HTML, so there are no code comments to strip; kept raw so `id` attributes stay visible. */
const pageCode = pageSource;

/** Count non-overlapping call sites, excluding the declaration. */
function callSites(source: string, name: string): number {
  const all = source.match(new RegExp(`\\b${name}\\(`, 'g'))?.length ?? 0;
  const declarations =
    source.match(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g'))?.length ?? 0;
  return all - declarations;
}

describe('the capture button saves a take — second-pass review finding', () => {
  /**
   * The first version's button only called `refresh()`. It captured nothing, and the dataset was
   * whatever happened to be in a rolling buffer holding ~32 seconds at 4.7 Hz.
   */

  it('calls take() from the button handler', () => {
    const handlerIndex = panelCode.indexOf("captureButton.addEventListener('click'");
    expect(handlerIndex).toBeGreaterThan(-1);
    // Not merely `refresh()` — the handler must save.
    expect(panelCode.slice(handlerIndex, handlerIndex + 500)).toContain('.take(');
  });

  it('reports a null take rather than pretending to save', () => {
    // A double-tap, or a tap before any observation, must say so.
    expect(panelCode).toContain('saved === null');
  });

  it('uses the injected take window rather than a hard-coded duration', () => {
    expect(panelCode).toContain('takeWindowMs');
    expect(mainCode).toContain('takeWindowMs');
  });

  it('keeps saved takes out of the rolling buffer entirely', () => {
    // `reset()` must not exist on the take path, and `clear()` is the only way takes are dropped.
    expect(captureCode).toContain('sessionFrameCapacity');
    expect(captureCode).toContain('enforceSessionCapacity');
  });
});

describe('the download guard and guidance — third-pass review findings', () => {
  it('guards the download on the saved dataset, not the rolling buffer', () => {
    // Testing `capture.size` let the app emit a valid JSON with `takeCount: 0`.
    const downloadIndex = panelCode.indexOf('private download()');
    expect(downloadIndex).toBeGreaterThan(-1);
    const body = panelCode.slice(downloadIndex, downloadIndex + 400);
    expect(body).toContain('takeCount === 0');
    expect(body).not.toContain('capture.size === 0');
  });

  it('reports how many takes were downloaded', () => {
    const downloadIndex = panelCode.indexOf('private download()');
    expect(panelCode.slice(downloadIndex, downloadIndex + 900)).toContain('labelCounts()');
  });

  it('derives the guidance from config rather than hard-coding prose', () => {
    // The panel writes the help text from `captureGuidanceText()`, so the stated hold time and the
    // take window share one source of truth.
    expect(panelCode).toContain('captureGuidanceText(');
    expect(mainCode).toContain('takeHoldGuidanceSeconds');
    expect(captureCode).not.toContain('about a second');
  });

  it('has a guidance element in the page for the panel to fill', () => {
    expect(pageCode).toContain('id="capture-help"');
  });
});

describe('an in-flight detection cannot act after a source switch', () => {
  /**
   * Second-pass review finding. `selectSource` stops the camera source but leaves the session and
   * its frame clock alive, and `detectNow` checks `started` before awaiting the backend — so a
   * request already in flight resolves successfully and its gesture would be dispatched while the
   * simulator is the active source.
   */

  it('routes the completion decision through the ownership predicate', () => {
    expect(mainCode).toContain('shouldApplyDetection(');
  });

  it('captures the selection generation before awaiting', () => {
    const detectIndex = mainCode.indexOf('session.source.detectNow(');
    expect(detectIndex).toBeGreaterThan(-1);
    // The generation must be recorded *before* the await, or the comparison is meaningless — the
    // player can switch sources while the request is in flight.
    const beforeAwait = mainCode.slice(0, detectIndex);
    expect(beforeAwait).toContain('const sourceGeneration = sourceSelectionGeneration');
  });

  it('bumps the generation on a real source change, and only then', () => {
    // The counter is what makes A → B → A detectable; object identity cannot see it.
    const selectIndex = mainCode.indexOf('function selectSource(');
    expect(selectIndex).toBeGreaterThan(-1);
    const body = mainCode.slice(selectIndex, selectIndex + 900);
    expect(body).toContain('sourceSelectionGeneration += 1');
    // After the early return, so re-selecting the active source does not invalidate a detection.
    expect(body.indexOf('if (next === activeSource) return;')).toBeLessThan(
      body.indexOf('sourceSelectionGeneration += 1'),
    );
  });

  it('does not fall back to the session-only check it replaced', () => {
    // `camera !== session` alone misses the source switch, which is the whole point.
    expect(mainCode).not.toContain('if (camera !== session) return;');
  });
});

describe('the camera path dispatches gesture events', () => {
  it('has exactly two event-dispatch call sites, one per input source', () => {
    // One for the camera observation callback, one for the simulator/replay render path.
    // Zero means events are dropped (the shipped bug); three or more risks double-firing.
    expect(callSites(mainCode, 'handleGestureEvents')).toBe(2);
  });

  it('dispatches from the camera observation callback', () => {
    // The regression: camera events were counted but never fired.
    const observeIndex = mainCode.indexOf('gestures.observe(latestTracked');
    expect(observeIndex).toBeGreaterThan(-1);

    // The dispatch must follow the camera observation, before the next unrelated statement.
    const afterObserve = mainCode.slice(observeIndex, observeIndex + 700);
    expect(afterObserve).toContain('handleGestureEvents(');
  });

  it('dispatches from the simulator/replay observation path', () => {
    const observeIndex = mainCode.indexOf('gestures.observe(tracked');
    expect(observeIndex).toBeGreaterThan(-1);
    expect(mainCode.slice(observeIndex, observeIndex + 500)).toContain('handleGestureEvents(');
  });

  it('does not fire from the render loop, where camera frames carry no events', () => {
    // Every shot must go through the dispatch, so there is no second path that could fire twice
    // or fire from a source that does not produce observations.
    expect(mainCode).not.toContain('game.fire(');
  });

  it('keeps game.fire behind the dispatch, in exactly one place', () => {
    expect(callSites(dispatchCode, 'game.fire')).toBe(1);
  });
});

describe('the dispatch cannot shoot from a position nobody observed', () => {
  it('rejects coasting hands', () => {
    // §7.2 keeps stale positions out of anything that decides gameplay, and aiming decides a hit.
    expect(dispatchCode).toContain('source.isStale');
  });

  it('keeps the capture from recording coasting hands', () => {
    // The other half of the same rule: a coasting hand's landmarks are the tracker's held copy,
    // so recording them would stamp a fresh timestamp on stale data and re-pollute tuning.
    // The check lives in the extracted function, which is where it is testable.
    expect(captureCode).toContain('hand.frozen');
  });

  it('records through the extracted function, not a private copy', () => {
    // Extracted so `observationCadence.test.ts` can drive the *real* implementation. A
    // test-local reimplementation would only prove the test agrees with itself — which is
    // precisely the coverage gap review flagged.
    //
    // One call site: `main.ts` keeps a thin wrapper, and the *wrapper* is what both source paths
    // call. Asserting that pair is the real invariant.
    expect(callSites(mainCode, 'recordGestureObservations')).toBe(1);
    expect(callSites(mainCode, 'recordGestureCapture')).toBe(2);
  });
});
