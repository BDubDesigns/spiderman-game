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

import { CAPTURE_LABELS, type CaptureLabel, type HandFrameCapture } from './capture';

/** DOM handles the panel owns. */
export interface CapturePanelElements {
  captureButton: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  clearButton: HTMLButtonElement;
  output: HTMLTextAreaElement;
  status: HTMLElement;
  /** Container the label buttons are built into, so `index.html` stays declarative-free. */
  labels: HTMLElement;
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
  private readonly labelButtons = new Map<CaptureLabel, HTMLButtonElement>();

  constructor(private readonly options: CapturePanelOptions) {
    const { captureButton, downloadButton, clearButton, labels } = options.elements;

    this.buildLabelButtons(labels);

    captureButton.addEventListener('click', () => {
      this.refresh();
    });

    downloadButton.addEventListener('click', () => {
      this.download();
    });

    clearButton.addEventListener('click', () => {
      options.capture.clear();
      options.elements.output.value = '';
      this.setStatus('Cleared. Pick a label, hold the pose, then tap Capture samples.');
    });

    this.refresh();
  }

  /**
   * Build the label picker.
   *
   * Built here rather than in `index.html` so the labels and the capture module cannot drift
   * apart: adding a label to `CAPTURE_LABELS` is enough, and a test can drive the same code.
   */
  private buildLabelButtons(container: HTMLElement): void {
    for (const { id, text } of CAPTURE_LABELS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.dataset['label'] = id;
      button.addEventListener('click', () => {
        this.options.capture.setLabel(id);
        this.refresh();
      });
      container.appendChild(button);
      this.labelButtons.set(id, button);
    }
  }

  /** Reflect the active label on the buttons, so the picker shows what it will record. */
  private syncLabelButtons(): void {
    const active = this.options.capture.currentLabel;
    for (const [id, button] of this.labelButtons) {
      const on = id === active;
      button.setAttribute('aria-pressed', String(on));
      button.classList.toggle('active', on);
    }
  }

  /** Re-render from the capture buffer. Called on a timer and on demand. */
  refresh(): void {
    const capture = this.options.capture;
    const frames = capture.size;

    this.syncLabelButtons();

    // Always show the latest capture, so "tap Capture" is really just "show me now".
    this.options.elements.output.value =
      frames === 0
        ? 'No observations captured yet.\n\n1. Pick a label below.\n' +
          '2. Hold that pose in front of the camera.\n' +
          '3. Tap Capture samples.\n\n' +
          'Repeat for each pose. One line appears per camera observation.'
        : capture.toTextSummary();

    const active = capture.currentLabel;
    this.setStatus(
      frames === 0
        ? 'Waiting for camera observations.'
        : `Holding ${frames} observation${frames === 1 ? '' : 's'}, labelling as "${active}".`,
    );
  }

  private download(): void {
    const capture = this.options.capture;
    if (capture.size === 0) {
      this.setStatus('Nothing captured yet — pick a label, hold the pose, then tap Capture.');
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
