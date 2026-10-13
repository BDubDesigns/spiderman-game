/**
 * Unit tests for detection ownership (PLAN.md §7.3).
 *
 * Requested by review on PR #12 after the second pass: *"add a deferred-result regression"*. The
 * race only exists when a detection **completes after** the source was switched, which no test
 * that runs the two in order can reproduce — so the predicate is named and these simulate the
 * deferral explicitly.
 */

import { describe, expect, it } from 'vitest';

import { shouldApplyDetection } from './detectionOwnership';

/** Stand-ins with identity, which is all the predicate compares. */
const cameraSession = { id: 'camera-session' };
const cameraSource = { id: 'camera-source' };
const mouseSource = { id: 'mouse-source' };
const replaySource = { id: 'replay-source' };

describe('shouldApplyDetection', () => {
  it('applies a detection that belongs to the live session and the active source', () => {
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSource: cameraSource,
        liveSource: cameraSource,
      }),
    ).toBe(true);
  });

  it('drops a detection whose session was torn down', () => {
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: null,
        startedForSource: cameraSource,
        liveSource: cameraSource,
      }),
    ).toBe(false);
  });

  it('drops a detection whose session was replaced by a new one', () => {
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: { id: 'camera-session-2' },
        startedForSource: cameraSource,
        liveSource: cameraSource,
      }),
    ).toBe(false);
  });

  it('drops a deferred result when the player switched to the simulator', () => {
    // The reported race: `1` stops the camera source but leaves the session alive, so
    // `liveSession === startedForSession` still holds. Only the source comparison catches it.
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSource: cameraSource,
        liveSource: mouseSource,
      }),
    ).toBe(false);
  });

  it('drops a deferred result when the player switched to replay', () => {
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSource: cameraSource,
        liveSource: replaySource,
      }),
    ).toBe(false);
  });

  it('drops a deferred result when the player switched back to the camera', () => {
    // Switching away and back produces a *different* source object, so a detection started
    // against the previous one is still dropped. Applying it would attribute an old frame to a
    // new session's identity state.
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSource: { id: 'camera-source-old' },
        liveSource: cameraSource,
      }),
    ).toBe(false);
  });

  it('models the full deferred sequence: start, switch, then complete', () => {
    // The arrangement the review described, in order. A detection is started for the camera…
    const startedForSession = cameraSession;
    const startedForSource = cameraSource;

    // …the player presses `1` while it is in flight. The session survives; the source changes.
    const liveSource: object = mouseSource;

    // …and only now does the backend resolve. The session is unchanged, so only the source
    // comparison can catch this.
    expect(
      shouldApplyDetection({
        startedForSession,
        liveSession: cameraSession,
        startedForSource,
        liveSource,
      }),
    ).toBe(false);
  });

  it('models the un-raced sequence, which must still apply', () => {
    // The guard must not break the ordinary case: nothing changed while the detection ran.
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSource: cameraSource,
        liveSource: cameraSource,
      }),
    ).toBe(true);
  });
});
