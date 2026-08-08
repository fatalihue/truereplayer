import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { uiZoom, rectToLayout, toLayout, viewportInLayout } from '../utils/zoomSpace';

/**
 * Where to draw a right-click menu so it opens at the cursor and stays on screen.
 *
 * The three context menus in the app — profile, folder (ProfilePanel) and grid row
 * (ActionTable) — each carried their own copy of the same two-pass dance:
 *
 *   pass 1  the anchor appears, so render the menu at (-9999, -9999). It is mounted
 *           and laid out at full size there, unclipped by the viewport, which is the
 *           only way to learn how tall it is — a menu whose height depends on the
 *           row it was opened over cannot be measured before it exists.
 *   pass 2  in a requestAnimationFrame (after the browser has laid pass 1 out),
 *           measure it and place it at the cursor, nudged back inside the viewport.
 *
 * The sentinel is written as an inline left/top, so it is -9999 LAYOUT px; even at the
 * 25 % zoom floor that is -2 500 visual px, still comfortably off screen.
 *
 * COORDINATE SPACES — the whole reason this is worth centralising. Read utils/zoomSpace
 * first. Every INPUT here is VISUAL and the OUTPUT is LAYOUT:
 *
 *   anchor.x / anchor.y   VISUAL — they are a MouseEvent's clientX/clientY (all three
 *                         call sites build the anchor from `e.clientX, e.clientY`).
 *   el.getBoundingClientRect()  VISUAL — measured.
 *   window.innerWidth/Height    VISUAL — measured (read inside viewportInLayout).
 *   the returned { x, y }       LAYOUT — the caller writes it to style.left / style.top,
 *                               and CSS zoom multiplies it again. Do NOT convert it a
 *                               second time on the way out.
 *
 * So all three inputs are converted ONCE, at the top, before any arithmetic — which is
 * what lets the 8 px margin below mean 8 px of inline CSS, its natural meaning. Mixing
 * the two spaces here is invisible at 100 % zoom and puts the menu 10 % of the cursor's
 * distance from the origin away from the cursor at the 90 % default.
 */

// Min gap to keep between the menu and the viewport edge (layout px, as everything is
// by the time it is used).
const MARGIN = 8;

// Off-screen staging spot for the measurement pass. Also the sentinel that TELLS the
// second effect it is looking at an unmeasured menu.
const OFFSCREEN = -9999;

/** A point in VISUAL space (a clientX/clientY), plus whatever else the caller keeps with it. */
export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * @param anchor  the open menu's cursor point, or null when no menu is open. Pass the
 *                state object straight through — the effects key off its identity, so a
 *                second right-click re-runs the measurement, and a re-render does not.
 * @param menuRef ref on the menu element itself (the one that gets style.left/top).
 * @returns the position to write, or null while there is no menu. During the measurement
 *          pass this is the off-screen sentinel, so `anchor && pos && <menu/>` renders it.
 */
export function useContextMenuPosition(
  anchor: MenuAnchor | null,
  menuRef: RefObject<HTMLElement | null>,
): { x: number; y: number } | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // A new anchor means a new measurement: stage the menu off-screen (or, with no anchor,
    // drop the position so a reopen can never flash at the last menu's spot). Deliberate
    // state-in-effect — the size that decides the final position does not exist until the
    // menu has been rendered somewhere, which is the whole point of the two passes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos(anchor ? { x: OFFSCREEN, y: OFFSCREEN } : null);
  }, [anchor]);

  useEffect(() => {
    if (!anchor || !pos) return;
    // Only the off-screen measurement pass has work to do here. Writing the real position
    // re-runs this effect, and this is where that second run stops (a measured x can never
    // be the sentinel: it is either a Math.max(MARGIN, …) or a converted clientX).
    if (pos.x !== OFFSCREEN) return;
    requestAnimationFrame(() => {
      const el = menuRef.current;
      if (!el) return;
      const zoom = uiZoom();
      const rect = rectToLayout(el.getBoundingClientRect(), zoom);
      const vp = viewportInLayout(zoom);
      let x = toLayout(anchor.x, zoom);
      let y = toLayout(anchor.y, zoom);
      // If the menu would overflow the bottom, move it up.
      if (y + rect.height > vp.height - MARGIN) {
        y = Math.max(MARGIN, y - rect.height);
      }
      // If the menu would overflow the right, move it left.
      if (x + rect.width > vp.width - MARGIN) {
        x = Math.max(MARGIN, vp.width - rect.width - MARGIN);
      }
      setPos({ x, y });
    });
  }, [anchor, pos, menuRef]);

  return pos;
}
