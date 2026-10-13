/**
 * Unit tests for long animation frame reporting.
 *
 * The point of this module is to replace a hand-wave with evidence, so the tests are
 * about extraction being faithful and about the feature detection never taking the
 * app down. `PerformanceObserver` is injected, so none of this needs a browser.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  describeLongFrame,
  observeLongFrames,
  type LongFrameEnvironment,
  type PerformanceObserverLike,
} from './longFrames';

/** A fabricated `long-animation-frame` entry, shaped like Chrome's. */
function longFrameEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryType: 'long-animation-frame',
    duration: 120,
    blockingDuration: 70,
    scripts: [
      { duration: 10, invoker: 'requestAnimationFrame' },
      { duration: 55, invoker: 'requestVideoFrameCallback' },
    ],
    ...overrides,
  };
}

describe('describeLongFrame', () => {
  it('extracts duration, blocking time and the longest script', () => {
    expect(describeLongFrame(longFrameEntry())).toEqual({
      durationMs: 120,
      blockingMs: 70,
      topInvoker: 'requestVideoFrameCallback',
    });
  });

  it('attributes the blocking to whichever script is longest, not the first', () => {
    const sample = describeLongFrame(
      longFrameEntry({
        scripts: [
          { duration: 40, invoker: 'first' },
          { duration: 5, invoker: 'second' },
        ],
      }),
    );
    expect(sample?.topInvoker).toBe('first');
  });

  it('tolerates a frame with no script attribution', () => {
    const sample = describeLongFrame(
      longFrameEntry({ scripts: undefined, blockingDuration: undefined }),
    );
    expect(sample).toEqual({ durationMs: 120, blockingMs: 0, topInvoker: '' });
  });

  it('ignores entries that are not long animation frames', () => {
    for (const entry of [
      { entryType: 'longtask', duration: 100 },
      null,
      undefined,
      'nope',
      42,
    ]) {
      expect(describeLongFrame(entry)).toBeNull();
    }
  });

  it('does not let a non-numeric duration poison the sample', () => {
    const sample = describeLongFrame(
      longFrameEntry({ duration: 'lots', blockingDuration: Number.NaN }),
    );
    expect(sample).toEqual({ durationMs: 0, blockingMs: 0, topInvoker: 'requestVideoFrameCallback' });
  });
});

describe('observeLongFrames', () => {
  function fakeEnvironment(supported: readonly string[]) {
    const disconnect = vi.fn();
    let emit: ((entries: unknown[]) => void) | null = null;
    const observe = vi.fn();
    const environment: LongFrameEnvironment = {
      supportedEntryTypes: supported,
      now: () => 1234,
      createObserver: (callback) => {
        emit = callback;
        const observer: PerformanceObserverLike = { observe, disconnect };
        return observer;
      },
    };
    return {
      environment,
      observe,
      disconnect,
      fire: (entries: unknown[]) => emit?.(entries),
    };
  }

  it('reports unsupported without creating an observer when the entry type is absent', () => {
    const harness = fakeEnvironment(['longtask', 'paint']);
    const onSample = vi.fn();

    const observer = observeLongFrames(onSample, harness.environment);

    expect(observer.kind).toBe('unsupported');
    expect(harness.observe).not.toHaveBeenCalled();
    // Disconnecting an unsupported observer must not throw.
    observer.disconnect();
  });

  it('reports unsupported when the platform has no PerformanceObserver at all', () => {
    const observer = observeLongFrames(vi.fn(), {
      supportedEntryTypes: [],
      now: () => 0,
    });
    expect(observer.kind).toBe('unsupported');
  });

  it('delivers one sample per long frame, with a timestamp', () => {
    const harness = fakeEnvironment(['long-animation-frame']);
    const onSample = vi.fn();

    const observer = observeLongFrames(onSample, harness.environment);
    expect(observer.kind).toBe('long-animation-frame');
    expect(harness.observe).toHaveBeenCalledWith({
      type: 'long-animation-frame',
      buffered: false,
    });

    harness.fire([longFrameEntry(), { entryType: 'paint' }]);

    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(
      { durationMs: 120, blockingMs: 70, topInvoker: 'requestVideoFrameCallback' },
      1234,
    );
  });

  it('degrades to unsupported when observe() is rejected', () => {
    // Claimed as supported but refused in practice must not take the app down over
    // instrumentation.
    const disconnect = vi.fn();
    const observer = observeLongFrames(vi.fn(), {
      supportedEntryTypes: ['long-animation-frame'],
      now: () => 0,
      createObserver: () => ({
        observe: () => {
          throw new Error('not supported after all');
        },
        disconnect,
      }),
    });

    expect(observer.kind).toBe('unsupported');
    expect(disconnect).toHaveBeenCalled();
  });

  it('disconnects exactly once even if called twice', () => {
    const harness = fakeEnvironment(['long-animation-frame']);
    const observer = observeLongFrames(vi.fn(), harness.environment);

    observer.disconnect();
    observer.disconnect();

    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });
});
