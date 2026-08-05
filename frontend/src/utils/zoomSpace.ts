/**
 * COORDINATE SPACES UNDER `zoom`.
 *
 * The app paints with CSS `zoom` on <html> (ThemeUISettings.zoom, 25 %–500 %, applied in
 * themes.ts applyThemeConfig). That splits the browser's geometry APIs into two spaces that
 * look identical at exactly 100 % and disagree everywhere else:
 *
 *   VISUAL — already multiplied by zoom. What you MEASURE:
 *            getBoundingClientRect(), MouseEvent.clientX/clientY, window.innerWidth/innerHeight,
 *            elementFromPoint().
 *   LAYOUT — about to be multiplied by zoom. What you WRITE:
 *            every inline CSS length — left, top, width, transform: translate(), …
 *
 * Measured with a probe at zoom 0.9: a position:fixed element asked for left:500px top:300px
 * width:100px landed at 450 / 270 / 90.
 *
 * So handing a measured number straight to an inline `left` applies the zoom twice, and the
 * element lands short of its target by (1 − zoom) × its distance from the viewport origin.
 * At the default 0.90 that is 10 % of x — a context menu opened at x = 1000 appears 100 px from
 * the cursor. At the 25 % floor it is 75 %. At 100 % it is nothing at all, which is why this
 * survived: it only exists for users who changed the zoom.
 *
 * Convert measurements ONCE, at the point they enter the placement maths, and every px constant
 * downstream keeps its natural meaning. Do not convert on the way out — that leaves the
 * constants stranded in the wrong space.
 *
 * Not every rect read needs this. Reading a rect only to COMPARE (does it fit? which side has
 * room?) is fine, and so is anything built from offsetTop/offsetWidth/scrollTop, which are
 * already layout-space. This matters when a measured number becomes a written coordinate.
 */

/** The subset of a DOMRect the placement helpers read, in whichever space it was put. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The live UI zoom as a plain number.
 *
 * themes.ts writes --ui-zoom alongside root.style.zoom expressly so consumers can compensate
 * without reading it back off the element and risking drift — the same token the
 * `calc(90vh / var(--ui-zoom))` viewport-unit fixes use. Falls back to 1, which turns every
 * conversion here into a no-op, so a missing token degrades to today's behaviour rather than
 * to NaN coordinates.
 */
export function uiZoom(): number {
  const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** A measured rect, converted into the space inline styles are written in. */
export function rectToLayout(r: DOMRect | Box, zoom: number): Box {
  return {
    left: r.left / zoom,
    right: r.right / zoom,
    top: r.top / zoom,
    bottom: r.bottom / zoom,
    width: r.width / zoom,
    height: r.height / zoom,
  };
}

/** A measured scalar — a clientX, an innerWidth, a rect edge — in layout space. */
export function toLayout(value: number, zoom: number): number {
  return value / zoom;
}

/** The viewport in layout space, for placement that has to stay on screen. */
export function viewportInLayout(zoom: number): { width: number; height: number } {
  return { width: window.innerWidth / zoom, height: window.innerHeight / zoom };
}
