/**
 * The mirrored camera pass (PLAN.md §8 Rule B, Rule F).
 *
 * Plane rules, so there is no ambiguity about where mirroring happens:
 *
 * - The **video image** is mirrored with a canvas transform, here.
 * - **Landmarks** are mirrored in code, in `toCanvas()`, and nowhere else.
 * - The **HUD** is drawn unmirrored, after this returns.
 * - Nothing is ever mirrored with CSS `scaleX(-1)`, because that would also flip
 *   HUD text and any DOM UI layered above the canvas.
 *
 * The transform is established and released inside this function, so a caller
 * cannot leave the mirror applied by accident. `restore()` is what clears it —
 * which is why this uses a save/restore pair rather than setting the transform
 * and handing the cleanup problem to the caller.
 */

/**
 * The narrow slice of `CanvasRenderingContext2D` this needs.
 *
 * `drawImage` is declared with method syntax deliberately: that keeps parameter
 * checking bivariant, so the real context's overloaded `drawImage` satisfies this
 * interface and tests can pass a recording stub with no DOM.
 */
export interface MirrorDrawSurface {
  save(): void;
  restore(): void;
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * Draw the camera frame mirrored to fill the canvas, then release the transform.
 *
 * The scale is `(-1, 0, 0, 1, cw, 0)`, which is the canvas-space equivalent of the
 * `1 - x` in `toCanvas()`. Both conventions must stay in step: if one changes,
 * landmarks and video separate, and PLAN.md §15 risk 1 is exactly that bug.
 */
export function drawMirroredVideo(
  surface: MirrorDrawSurface,
  video: CanvasImageSource,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) {
    // A zero-sized backing store means Rule A was not honoured, and the draw
    // would silently no-op while landmarks piled up at the origin.
    throw new RangeError(
      `canvas dimensions must be positive, got ${canvasWidth}x${canvasHeight}`,
    );
  }

  surface.save();
  surface.setTransform(-1, 0, 0, 1, canvasWidth, 0);
  surface.drawImage(video, 0, 0, canvasWidth, canvasHeight);
  surface.restore();
}
