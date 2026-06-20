import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Pending = { text: string; rect: DOMRect; pos: string; mx: number; my: number };

// Single global tooltip renderer for the whole app. Any element with a `data-tip="..."` attribute
// shows a tooltip on hover, rendered as a body portal — so it's instant (no native-title ~1s lag),
// never clipped by panel/modal overflow, wraps at a max width, and auto-positions with flip + clamp
// to stay on-screen. `data-tip-pos` (left | right | end | below-start) is an optional placement hint.
// Replaces the native title= tooltips, the old [data-tip]::after CSS, and the per-row settings portal.
// Mount ONCE near the app root.
export function TooltipLayer() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const currentTarget = useRef<Element | null>(null);

  useEffect(() => {
    const hide = () => { currentTarget.current = null; setPending(null); setCoords(null); };
    const show = (el: HTMLElement, mx: number, my: number) => {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      currentTarget.current = el;
      setCoords(null); // re-measure before showing
      setPending({ text, rect: el.getBoundingClientRect(), pos: el.getAttribute('data-tip-pos') || 'auto', mx, my });
    };
    const onOver = (e: Event) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el && el !== currentTarget.current) show(el, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    };
    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]');
      if (!el || el !== currentTarget.current) return;
      const to = e.relatedTarget as Node | null;
      if (to && el.contains(to)) return; // still inside the same target
      hide();
    };
    // capture phase + delegation so it works for every element, present or future.
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    // The anchor rect is captured at hover time, so a scroll would strand the tooltip — hide it.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Measure the rendered tooltip, then place it relative to the anchor (honouring data-tip-pos),
  // flipping up if there's no room below and clamping to the viewport so it never goes off-screen.
  useLayoutEffect(() => {
    if (!pending || !tipRef.current) return;
    const a = pending.rect;
    const t = tipRef.current.getBoundingClientRect();
    const gap = 10, m = 8, CURSOR = 24; // CURSOR: keep below/above tooltips clear of the pointer
    const vw = window.innerWidth, vh = window.innerHeight;
    let left: number, top: number;
    let flippedAbove = false; // default placement had to flip above the anchor
    switch (pending.pos) {
      case 'left':
        left = a.left - gap - t.width; top = a.top + a.height / 2 - t.height / 2; break;
      case 'right':
        left = a.right + gap; top = a.top + a.height / 2 - t.height / 2; break;
      case 'below-start':
        left = a.left; top = a.bottom + gap; break;
      case 'end':
        left = a.right - t.width; top = a.bottom + gap; break;
      default: // below, centred; flip above if no room below
        left = a.left + a.width / 2 - t.width / 2;
        top = a.bottom + gap;
        if (top + t.height > vh - m) { top = a.top - gap - t.height; flippedAbove = true; }
    }
    // Cursor clearance for the below/above placements: push the tooltip past the pointer so it
    // never covers the cursor (the anchor is under the cursor, and a tight below-gap would land the
    // tooltip right on the pointer tip). Side placements (left/right) already sit clear of it.
    if (Number.isFinite(pending.my) && (pending.pos === 'auto' || pending.pos === 'below-start' || pending.pos === 'end')) {
      if (flippedAbove) top = Math.min(top, pending.my - CURSOR - t.height);
      else top = Math.max(top, pending.my + CURSOR);
    }
    // Clamp so the top-left corner is never < m, even when space is tight (max wins outermost).
    left = Math.max(m, Math.min(left, vw - t.width - m));
    top = Math.max(m, Math.min(top, vh - t.height - m));
    setCoords({ left, top });
  }, [pending]);

  if (!pending) return null;
  return createPortal(
    <div
      ref={tipRef}
      className="app-tip"
      // Render off-screen for the measure pass (useLayoutEffect runs before paint, so this is
      // never visible), then snap to the computed position.
      style={coords ? { left: coords.left, top: coords.top } : { left: -9999, top: -9999 }}
    >
      {pending.text}
    </div>,
    document.body,
  );
}
