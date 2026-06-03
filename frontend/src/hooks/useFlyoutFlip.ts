import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Submenus and dropdowns in this app are positioned purely with Tailwind classes
 * relative to their trigger:
 *   - a context-menu submenu opens to the side  →  `absolute left-full top-0`
 *   - a toolbar dropdown opens downward          →  `absolute top-full left-0`
 * Neither accounts for the viewport edge, so a trigger near the right/bottom pushes
 * the flyout partly off-screen and clips it (e.g. the profile "More ▸" submenu when
 * the profile sits low in the list, so the submenu opens downward off the bottom).
 *
 * This hook measures the flyout the instant it opens — in useLayoutEffect, before the
 * browser paints, so there is no visible jump — and reports whether it should flip to
 * the opposite side on each axis. The caller swaps the Tailwind class accordingly:
 *
 *   placement 'side'  (submenu):  left-full ⇄ right-full ,  top-0    ⇄ bottom-0
 *   placement 'below' (dropdown): left-0    ⇄ right-0    ,  top-full ⇄ bottom-full
 *
 * It flips only when the opposite side genuinely has room, so a flyout never trades a
 * clip on one edge for a clip on the other; when neither side fits it stays put.
 *
 * The anchor it measures against is the flyout's offsetParent — i.e. the
 * `position: relative` wrapper that holds both the trigger and the flyout — so call
 * sites don't have to thread a separate anchor ref through. (Every call site already
 * wraps trigger + flyout in a `relative` div, which is exactly that offsetParent.)
 */
export type FlyoutPlacement = 'side' | 'below';

// Min gap to keep between the flyout and the viewport edge.
const MARGIN = 8;

export function useFlyoutFlip(open: boolean, placement: FlyoutPlacement = 'side') {
  const ref = useRef<HTMLDivElement>(null);
  const [{ flipX, flipY }, setFlip] = useState({ flipX: false, flipY: false });

  useLayoutEffect(() => {
    // Only measure while open. When closed the flyout is unmounted, so there's nothing to
    // measure — and no need to reset: the computation below depends only on the anchor's
    // position and the flyout's size, never on which side it's currently rendered, so a
    // stale flip from the previous open is always re-measured correctly (before paint,
    // since this is useLayoutEffect) the next time it opens.
    if (!open) return;
    const el = ref.current;
    const anchor = el?.offsetParent as HTMLElement | null;
    if (!el || !anchor) return;
    // Measure both rects with getBoundingClientRect so every value is fractional and on the
    // same scale. Mixing it with offsetWidth/offsetHeight (integer-rounded) skews the
    // comparison by up to a pixel, which is enough to mis-decide a flyout that sits right at
    // the edge. w/h include the 4px padding gap on 'side' flyouts (padding is inside the box).
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let nextX = false;
    let nextY = false;
    if (placement === 'side') {
      // Default opens to the right of the anchor (card spans [a.right, a.right + w]),
      // top-aligned to it (card spans [a.top, a.top + h]).
      nextX = a.right + w > vw - MARGIN && a.left - w >= MARGIN;
      nextY = a.top + h > vh - MARGIN && a.bottom - h >= MARGIN;
    } else {
      // Default opens below the anchor (card spans [a.bottom, a.bottom + h]),
      // left-aligned to it (card spans [a.left, a.left + w]).
      nextX = a.left + w > vw - MARGIN && a.right - w >= MARGIN;
      nextY = a.bottom + h > vh - MARGIN && a.top - h >= MARGIN;
    }
    // Deliberate measure-then-reposition: the flip can only be known after the flyout is
    // laid out, so we read its size here and feed it back as state. This is the layout
    // measurement exception the set-state-in-effect rule warns about, run in
    // useLayoutEffect so the corrected side is committed before the browser paints.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlip({ flipX: nextX, flipY: nextY });
  }, [open, placement]);

  return { ref, flipX, flipY };
}
