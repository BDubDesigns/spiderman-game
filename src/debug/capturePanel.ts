/**
 * The on-screen capture panel.
 *
 * Exists because **a phone has no keyboard**. The project's existing diagnostics are
 * keyboard-driven (`E` exports measurements), which the maintainer could not use on the
 * Pixel, so the gesture capture is button-driven and its output is a selectable textarea
 * as well as a download.
 *
 * Kept out of the gameplay path: it lives in the DOM below the canvas, never draws over
 * the stage, and is inert until a button is pressed.
 */

import type { HandFrameCapture } from './capture';

/** DOM handles the panel owns. */
export interface CapturePanelElements {
  captureButton: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  clearButton: HTMLButtonElement;
  output: HTMLTextAreaElement;
  status: HTMLElement;
}

export interface CapturePanelOptions {
  capture: HandFrameCapture;
  elements: CapturePanelElements;
  /** Injected so the panel is testable without a document. */
  now: () => Date;
  url: () => string;
  /** Creates an object URL for the download; injected for testability. */
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
}

/** `YYYY-MM-DD HH:MM:SS`, so a capture can be matched to a session. */
function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export class CapturePanel {
  constructor(private readonly options: CapturePanelOptions) {
    const { captureButton, downloadButton, clearButton } = options.elements;

    captureButton.addEventListener('click', () => {
      this.refresh();
    });

    downloadButton.addEventListener('click', () => {
      this.download();
    });

    clearButton.addEventListener('click', () => {
      options.capture.clear();
      options.elements.output.value = '';
      this.setStatus('Cleared. Pose the gesture again, then tap Capture.');
    });

    this.refresh();
  }

  /** Re-render from the capture buffer. Called on a timer and on demand. */
  refresh(): void {
    const capture = this.options.capture;
    const frames = capture.size;

    // Always show the latest capture, so "tap Capture" is really just "show me now".
    this.options.elements.output.value =
      frames === 0
        ? 'No frames captured yet.\n\nPress and hold the web gesture (middle and ring ' +
          'pressed to the palm, index and pinky out) while the camera is running, then ' +
          'tap Capture samples.'
        : capture.toTextSummary();

    this.setStatus(
      frames === 0
        ? 'Waiting for observed hand frames.'
        : `Holding ${frames} observed frame${frames === 1 ? '' : 's'}.`,
    );
  }

  private download(): void {
    const capture = this.options.capture;
    if (capture.size === 0) {
      this.setStatus('Nothing captured yet — pose the gesture first, then tap Capture.');
      return;
    }
    const json = capture.toJson({
      url: this.options.url(),
      capturedAt: stamp(this.options.now()),
    });
    const url = this.options.createObjectUrl(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'web-slinger-gesture-capture.json';
    anchor.click();
    this.options.revokeObjectUrl(url);
    this.setStatus(
      'Downloaded the full JSON. Hand it back for offline replay, or paste the text above ' +
        'if a few numbers are enough.',
    );
  }

  private setStatus(message: string): void {
    this.options.elements.status.textContent = message;
  }
}
