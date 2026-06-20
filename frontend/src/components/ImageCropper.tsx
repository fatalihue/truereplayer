import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode =
  | 'move'
  | 'nw' | 'n' | 'ne'
  | 'w' | 'e'
  | 'sw' | 's' | 'se';

interface ImageCropperProps {
  imageBase64: string;
  onSave: (rect: CropRect) => void;
  onCancel: () => void;
}

const MIN_SIZE = 10;
const MAX_DISPLAY_W = 900;
const MAX_DISPLAY_H = 600;
const HANDLE_PX = 12;
// Crop rect overlay colors — slightly transparent so the underlying image stays readable
// while still giving the crop rect enough contrast to be visible against any background.
const ACCENT_RGBA = 'rgba(96, 205, 255, 0.65)';
const HANDLE_BORDER_RGBA = 'rgba(255, 255, 255, 0.7)';

// Modal cropper for tightening an existing reference image. Operates purely in image-pixel
// coordinates (the parent persists those via the bridge); display scaling is calculated
// on the fly so the UI works for any reference size from a tiny 30px icon up to a 600px panel.
export function ImageCropper({ imageBase64, onSave, onCancel }: ImageCropperProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, w: 0, h: 0 });
  const dragRef = useRef<{ mode: DragMode; startX: number; startY: number; startCrop: CropRect } | null>(null);

  const onImageLoad = useCallback(() => {
    if (!imgRef.current) return;
    const nw = imgRef.current.naturalWidth;
    const nh = imgRef.current.naturalHeight;
    setNatural({ w: nw, h: nh });
    setCrop({ x: 0, y: 0, w: nw, h: nh });
  }, []);

  // Always fit the image into the MAX_W × MAX_H box while preserving aspect ratio. Small
  // reference images get scaled UP so the handles are easy to grab; big ones get scaled
  // DOWN to fit. The crop rect stays in image-pixel coords; only its display position
  // scales by `display.scale`.
  const display = useMemo(() => {
    if (!natural) return null;
    const scale = Math.min(MAX_DISPLAY_W / natural.w, MAX_DISPLAY_H / natural.h);
    return {
      width: natural.w * scale,
      height: natural.h * scale,
      scale,
    };
  }, [natural]);
  const displayScale = display?.scale ?? 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  // Global mousemove/mouseup so the drag survives even if the cursor briefly leaves the
  // handle while dragging fast.
  useEffect(() => {
    function clamp(v: number, min: number, max: number) {
      return Math.max(min, Math.min(max, v));
    }
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !natural) return;
      const dx = (e.clientX - d.startX) / displayScale;
      const dy = (e.clientY - d.startY) / displayScale;
      let { x, y, w, h } = d.startCrop;
      const right = d.startCrop.x + d.startCrop.w;
      const bottom = d.startCrop.y + d.startCrop.h;
      switch (d.mode) {
        case 'move':
          x = clamp(x + dx, 0, natural.w - w);
          y = clamp(y + dy, 0, natural.h - h);
          break;
        case 'nw':
          x = clamp(d.startCrop.x + dx, 0, right - MIN_SIZE);
          y = clamp(d.startCrop.y + dy, 0, bottom - MIN_SIZE);
          w = right - x;
          h = bottom - y;
          break;
        case 'n':
          y = clamp(d.startCrop.y + dy, 0, bottom - MIN_SIZE);
          h = bottom - y;
          break;
        case 'ne':
          y = clamp(d.startCrop.y + dy, 0, bottom - MIN_SIZE);
          h = bottom - y;
          w = clamp(d.startCrop.w + dx, MIN_SIZE, natural.w - x);
          break;
        case 'w':
          x = clamp(d.startCrop.x + dx, 0, right - MIN_SIZE);
          w = right - x;
          break;
        case 'e':
          w = clamp(d.startCrop.w + dx, MIN_SIZE, natural.w - x);
          break;
        case 'sw':
          x = clamp(d.startCrop.x + dx, 0, right - MIN_SIZE);
          w = right - x;
          h = clamp(d.startCrop.h + dy, MIN_SIZE, natural.h - y);
          break;
        case 's':
          h = clamp(d.startCrop.h + dy, MIN_SIZE, natural.h - y);
          break;
        case 'se':
          w = clamp(d.startCrop.w + dx, MIN_SIZE, natural.w - x);
          h = clamp(d.startCrop.h + dy, MIN_SIZE, natural.h - y);
          break;
      }
      setCrop({
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [natural, displayScale]);

  const startDrag = (mode: DragMode) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startCrop: { ...crop },
    };
  };

  const dispCrop = {
    left: crop.x * displayScale,
    top: crop.y * displayScale,
    width: crop.w * displayScale,
    height: crop.h * displayScale,
  };

  const canSave =
    natural !== null &&
    crop.w >= MIN_SIZE &&
    crop.h >= MIN_SIZE &&
    !(crop.x === 0 && crop.y === 0 && crop.w === natural.w && crop.h === natural.h);

  // Each handle is a small filled square positioned so its CENTRE sits on the edge/corner of
  // the crop rect. The offset (negative half the size) keeps it visually centred on the edge.
  // Slightly transparent so the image underneath remains visible at the corners.
  const handleStyle: React.CSSProperties = {
    position: 'absolute',
    width: HANDLE_PX,
    height: HANDLE_PX,
    background: ACCENT_RGBA,
    border: `1px solid ${HANDLE_BORDER_RGBA}`,
    boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
    borderRadius: 2,
  };
  const half = HANDLE_PX / 2;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="bg-bg-elevated border border-border-default rounded-lg shadow-2xl p-4 max-w-[90vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">Crop reference image</h3>
          <div className="text-xs font-mono text-text-tertiary">
            {natural ? `${crop.w} × ${crop.h}` : 'Loading...'}
            {natural && <span className="text-text-disabled"> / {natural.w} × {natural.h}</span>}
          </div>
        </div>

        {/* Centred container — the image+crop overlay sit inside a flex centerer so they
            don't hug the left edge of the modal when the image is smaller than the modal. */}
        <div className="flex justify-center">
          <div className="relative inline-block bg-black/40">
          <img
            ref={imgRef}
            src={`data:image/png;base64,${imageBase64}`}
            onLoad={onImageLoad}
            alt="Reference"
            className="block select-none"
            style={display ? { width: display.width, height: display.height } : undefined}
            draggable={false}
          />

          {natural && crop.w > 0 && (
            <>
              {/* Four divs dim the area OUTSIDE the crop rect. Pointer-events:none so the user
                  can still grab the move/resize handles inside without the overlay swallowing it. */}
              <div
                className="absolute pointer-events-none"
                style={{ left: 0, top: 0, right: 0, height: dispCrop.top, background: 'rgba(0,0,0,0.55)' }}
              />
              <div
                className="absolute pointer-events-none"
                style={{ left: 0, top: dispCrop.top + dispCrop.height, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)' }}
              />
              <div
                className="absolute pointer-events-none"
                style={{ left: 0, top: dispCrop.top, width: dispCrop.left, height: dispCrop.height, background: 'rgba(0,0,0,0.55)' }}
              />
              <div
                className="absolute pointer-events-none"
                style={{
                  left: dispCrop.left + dispCrop.width,
                  top: dispCrop.top,
                  right: 0,
                  height: dispCrop.height,
                  background: 'rgba(0,0,0,0.55)',
                }}
              />

              {/* Crop rect — draggable to move, with 8 resize handles. */}
              <div
                className="absolute"
                style={{
                  left: dispCrop.left,
                  top: dispCrop.top,
                  width: dispCrop.width,
                  height: dispCrop.height,
                  border: `2px solid ${ACCENT_RGBA}`,
                  cursor: 'move',
                }}
                onMouseDown={startDrag('move')}
              >
                <div style={{ ...handleStyle, left: -half, top: -half, cursor: 'nw-resize' }} onMouseDown={startDrag('nw')} />
                <div style={{ ...handleStyle, left: '50%', top: -half, marginLeft: -half, cursor: 'n-resize' }} onMouseDown={startDrag('n')} />
                <div style={{ ...handleStyle, right: -half, top: -half, cursor: 'ne-resize' }} onMouseDown={startDrag('ne')} />
                <div style={{ ...handleStyle, left: -half, top: '50%', marginTop: -half, cursor: 'w-resize' }} onMouseDown={startDrag('w')} />
                <div style={{ ...handleStyle, right: -half, top: '50%', marginTop: -half, cursor: 'e-resize' }} onMouseDown={startDrag('e')} />
                <div style={{ ...handleStyle, left: -half, bottom: -half, cursor: 'sw-resize' }} onMouseDown={startDrag('sw')} />
                <div style={{ ...handleStyle, left: '50%', bottom: -half, marginLeft: -half, cursor: 's-resize' }} onMouseDown={startDrag('s')} />
                <div style={{ ...handleStyle, right: -half, bottom: -half, cursor: 'se-resize' }} onMouseDown={startDrag('se')} />
              </div>
            </>
          )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-3 gap-2">
          <div className="text-[10px] text-text-tertiary">
            Drag a handle to resize, or drag inside the rectangle to move.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border-default rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(crop)}
              disabled={!canSave}
              className="px-3 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-tip={canSave ? 'Apply crop' : 'Pick a smaller region first'}
            >
              Save crop
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
