using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading.Tasks;
using System.Windows.Forms;
using TrueReplayer.Interop;

namespace TrueReplayer.Services
{
    public class RegionSelectionResult
    {
        // Null when the form was constructed in region-only mode (e.g. configuring a WaitImage
        // search ROI) — only the rect coordinates matter, no reference image is being captured.
        public Bitmap? CroppedImage { get; set; }
        public int ScreenX { get; set; }
        public int ScreenY { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        // Only set in pointPick mode — the colour of the pixel the user clicked on, sampled
        // directly from the in-memory screenshot (no second screen capture). Null for region
        // or recapture flows where a single colour wouldn't be meaningful. Used by the
        // WaitPixelColor eyedropper to fill the target-colour swatch alongside X/Y.
        public Color? PickedColor { get; set; }
    }

    public class ScreenOverlayForm : Form
    {
        private readonly Bitmap _screenshot;
        private readonly bool _regionOnly;
        private readonly bool _pointPick;
        private readonly string _hintText;
        private readonly TaskCompletionSource<RegionSelectionResult?> _tcs = new();

        // GetSystemMetrics indices for the virtual desktop (all monitors) — Win32 SM_* constants.
        private const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

        private Point _startPoint;
        private Point _currentPoint;
        private bool _isDragging;
        private bool _hasSelection;
        // Live cursor position used to render an "(x, y)" label next to the mouse — like
        // ShareX / Greenshot. Lets the user see the exact coords they'll capture before
        // committing. Updated on every MouseMove regardless of drag state.
        private Point _cursorPoint;
        private bool _hasCursor;
        // Last painted label rect, captured from inside OnPaint after the actual MeasureString
        // ran. Used to invalidate (lastPainted ∪ newApprox) on cursor move so the previous
        // label is cleared. An earlier draft computed this rect twice — once approximated in
        // OnMouseMove, again actually in OnPaint — and the approximation under-estimated the
        // real width, leaving a smeared trail of label pixels along the cursor path. Tracking
        // the truth from OnPaint avoids the divergence.
        private Rectangle _lastCursorLabelRect = Rectangle.Empty;
        // Cached virtual-screen origin so the cursor label can show absolute screen coords
        // (matching the values the action will end up storing). The form already uses these
        // to compute its size; reading them once in the ctor avoids re-querying on every paint.
        private readonly int _virtualOriginX;
        private readonly int _virtualOriginY;

        // <paramref name="regionOnly"/>: when true, the overlay returns just the rect coords
        // without producing a cropped Bitmap. Used to configure the search ROI of an existing
        // WaitImage action — no new reference image is being captured.
        //
        // <paramref name="pointPick"/>: when true, a single mouse click returns immediately as
        // a zero-size "region" — used by Pick Position on click actions to set X/Y from a
        // direct screen click without dragging a rect.
        //
        // <paramref name="initialRect"/>: when non-null and the rect is large enough, the overlay
        // opens with that region already drawn (in screen-absolute coords). Lets the user see
        // what's currently saved instead of starting blank — they can hit ESC to keep it as-is,
        // or drag a new selection to overwrite. Ignored in pointPick mode.
        public ScreenOverlayForm(Bitmap screenshot, bool regionOnly = false, bool pointPick = false, string? hintText = null, Rectangle? initialRect = null)
        {
            _screenshot = screenshot;
            _regionOnly = regionOnly;
            _pointPick = pointPick;

            // Virtual screen bounds (all monitors)
            int vx = NativeMethods.GetSystemMetrics(SM_XVIRTUALSCREEN);
            int vy = NativeMethods.GetSystemMetrics(SM_YVIRTUALSCREEN);
            int vw = NativeMethods.GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int vh = NativeMethods.GetSystemMetrics(SM_CYVIRTUALSCREEN);
            _virtualOriginX = vx;
            _virtualOriginY = vy;

            // Seed the selection from a previously-saved rect so the user sees what's already
            // there. Same minimum size as OnMouseUp (10x10) — anything smaller is treated as
            // "no usable seed" and the overlay opens blank. Converts screen-absolute to
            // form-local by subtracting the virtual origin.
            bool seeded = false;
            if (initialRect.HasValue && !pointPick)
            {
                var r = initialRect.Value;
                if (r.Width >= 10 && r.Height >= 10)
                {
                    _startPoint = new Point(r.X - vx, r.Y - vy);
                    _currentPoint = new Point(r.X - vx + r.Width, r.Y - vy + r.Height);
                    _hasSelection = true;
                    seeded = true;
                }
            }

            _hintText = hintText ?? (pointPick
                ? "Click to pick  •  Scroll to zoom  •  ESC to cancel"
                : seeded
                    ? "Drag to redraw the region  •  ESC to keep current"
                    : "Click and drag to select a region  •  ESC to cancel");

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(vx, vy);
            Size = new Size(vw, vh);
            TopMost = true;
            ShowInTaskbar = false;
            DoubleBuffered = true;
            Cursor = Cursors.Cross;

            KeyPreview = true;
            KeyDown += OnKeyDown;
            MouseDown += OnMouseDown;
            MouseMove += OnMouseMove;
            MouseUp += OnMouseUp;
            MouseWheel += OnMouseWheel;
        }

        public Task<RegionSelectionResult?> GetSelectionAsync() => _tcs.Task;

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            // Guarantee the awaiting caller is always released, even when the form is closed by a
            // route that doesn't hit the ESC / click / drag handlers (Alt+F4, taskkill, the system
            // menu, or teardown after a paint exception). Without this the caller would block forever
            // on .Result. TrySetResult is idempotent, so a normal completion already set is unaffected.
            _tcs.TrySetResult(null);
            base.OnFormClosed(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;

            // Draw screenshot as background
            g.DrawImage(_screenshot, 0, 0);

            // Dark overlay on entire screen
            using var overlay = new SolidBrush(Color.FromArgb(100, 0, 0, 0));
            g.FillRectangle(overlay, ClientRectangle);

            if (_isDragging || _hasSelection)
            {
                var rect = GetSelectionRect();
                if (rect.Width > 0 && rect.Height > 0)
                {
                    // Draw the clear (un-tinted) region
                    g.DrawImage(_screenshot, rect, rect, GraphicsUnit.Pixel);

                    // Selection border
                    using var pen = new Pen(Color.FromArgb(255, 96, 205, 255), 2f); // #60CDFF accent
                    g.DrawRectangle(pen, rect);

                    // Dimension label
                    string label = $"{rect.Width} × {rect.Height}";
                    using var font = new Font("Segoe UI", 11f, FontStyle.Regular);
                    var labelSize = g.MeasureString(label, font);
                    float labelX = rect.X + (rect.Width - labelSize.Width) / 2;
                    float labelY = rect.Bottom + 6;

                    // Ensure label stays on screen
                    if (labelY + labelSize.Height > ClientRectangle.Height)
                        labelY = rect.Top - labelSize.Height - 6;

                    using var bgBrush = new SolidBrush(Color.FromArgb(200, 0, 0, 0));
                    g.FillRectangle(bgBrush, labelX - 4, labelY - 2, labelSize.Width + 8, labelSize.Height + 4);
                    using var textBrush = new SolidBrush(Color.White);
                    g.DrawString(label, font, textBrush, labelX, labelY);
                }
            }

            // Instruction text at top center. Visible whenever the user isn't actively dragging
            // — including the seeded-rect case where _hasSelection is true at startup, so the
            // "ESC to keep current" hint reaches the user before they touch the mouse.
            if (!_isDragging)
            {
                string hint = _hintText;
                using var font = new Font("Segoe UI", 13f, FontStyle.Regular);
                var size = g.MeasureString(hint, font);
                float hx = (ClientRectangle.Width - size.Width) / 2;
                float hy = 40;

                using var bgBrush = new SolidBrush(Color.FromArgb(180, 0, 0, 0));
                g.FillRoundedRectangle(bgBrush, hx - 12, hy - 6, size.Width + 24, size.Height + 12, 8);
                using var textBrush = new SolidBrush(Color.White);
                g.DrawString(hint, font, textBrush, hx, hy);
            }

            // Cursor callout — drawn last so it sits above the overlay tint and any
            // selection rect. Skipped once a selection is committed (hasSelection && !drag)
            // because the click already landed and the value is captured.
            //
            // ShareX-style zoom magnifier for every selection mode — pointPick (Wait Pixel),
            // regionOnly (Click Area / Wait Image search region) and image crop (Wait Image
            // initial capture / recapture). All benefit from pixel-level precision either
            // at the click point or at the rect corner being dragged. The HEX line in the
            // chip is gated to pointPick inside DrawMagnifier (other modes don't need colour).
            if (!_hasSelection || _isDragging)
            {
                DrawMagnifier(g);
            }
        }

        private Rectangle GetSelectionRect()
        {
            int x = Math.Min(_startPoint.X, _currentPoint.X);
            int y = Math.Min(_startPoint.Y, _currentPoint.Y);
            int w = Math.Abs(_currentPoint.X - _startPoint.X);
            int h = Math.Abs(_currentPoint.Y - _startPoint.Y);
            return new Rectangle(x, y, w, h);
        }

        private void OnKeyDown(object? sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape)
            {
                _tcs.TrySetResult(null);
                Close();
            }
        }

        private void OnMouseDown(object? sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                if (_pointPick)
                {
                    // Single-click capture — no drag needed. Width/Height stay 0 to mark this
                    // result as a point rather than a region; callers index off ScreenX/ScreenY.
                    // Also sample the colour at the click directly from the in-memory
                    // screenshot — the WaitPixelColor eyedropper consumes this, and even
                    // callers that ignore it (Pick Position) pay only one GetPixel call.
                    // Guarded against out-of-form coordinates so a fast click on the edge
                    // can't throw.
                    Color? pickedColor = null;
                    if (e.Location.X >= 0 && e.Location.Y >= 0
                        && e.Location.X < _screenshot.Width && e.Location.Y < _screenshot.Height)
                    {
                        try { pickedColor = _screenshot.GetPixel(e.Location.X, e.Location.Y); }
                        catch { /* defensive — bitmap access can race with Dispose on cancel */ }
                    }

                    _tcs.TrySetResult(new RegionSelectionResult
                    {
                        CroppedImage = null,
                        ScreenX = e.Location.X + _virtualOriginX,
                        ScreenY = e.Location.Y + _virtualOriginY,
                        Width = 0,
                        Height = 0,
                        PickedColor = pickedColor,
                    });
                    Close();
                    return;
                }
                _startPoint = e.Location;
                _currentPoint = e.Location;
                _isDragging = true;
                _hasSelection = false;
            }
        }

        private void OnMouseMove(object? sender, MouseEventArgs e)
        {
            // Track cursor for the live "(x, y)" label even when not dragging. Without this
            // the user has no idea where on screen they're about to click in pointPick mode,
            // and in rect mode they can't preview the start point before pressing.
            if (e.Location == _cursorPoint && _hasCursor && !_isDragging) return;  // no-op move
            _cursorPoint = e.Location;
            _hasCursor = true;

            if (_isDragging)
            {
                _currentPoint = e.Location;
                // Drag is already a full-form gesture (rect + dim label changes); a full
                // invalidate is the simplest correct option here.
                Invalidate();
                return;
            }

            // Not dragging — only the cursor coord HUD changed. Invalidate the union of the
            // PREVIOUSLY-PAINTED label rect (captured at the end of OnPaint, so it reflects
            // the real MeasureString width and any edge-flip that happened) and a generous
            // approximation of where the new label will land. Inflated by 8 px on each axis
            // to absorb font-metric drift between the estimate and the actual paint result —
            // the earlier 1-px inflate left a smeared trail when the cursor moved fast across
            // wide-digit coordinate strings.
            var newRect = ComputeCursorLabelRect();
            var dirty = _lastCursorLabelRect.IsEmpty ? newRect : Rectangle.Union(_lastCursorLabelRect, newRect);
            dirty.Inflate(8, 8);
            Invalidate(dirty);
        }

        // Mouse-wheel zoom for the magnifier (PowerToys-style). Scroll up = zoom in (fewer, larger
        // source pixels), down = zoom out. The cursor doesn't move, so a full invalidate repaints
        // the resized disc in place; wheel events are low-frequency so the full repaint is cheap.
        private void OnMouseWheel(object? sender, MouseEventArgs e)
        {
            int prev = _zoomIndex;
            if (e.Delta > 0) _zoomIndex = Math.Max(0, _zoomIndex - 1);
            else if (e.Delta < 0) _zoomIndex = Math.Min(ZoomLevels.Length - 1, _zoomIndex + 1);
            if (_zoomIndex != prev) Invalidate();
        }

        // Magnifier zoom — PowerToys-style mouse-wheel zoom. Each level is (source-pixel count
        // across the disc, on-screen px per pixel); counts are ODD so the centre pixel sits exactly
        // under the cursor. Scrolling up steps toward fewer/larger pixels (more magnification).
        // Index 2 (11 × 13 = 143 px disc) was the original fixed magnifier. The disc size varies a
        // little per level; ComputeCursorLabelRect / DrawMagnifier read these as LIVE values so the
        // layout + flip-on-edge logic always tracks the current zoom.
        private static readonly (int count, int size)[] ZoomLevels =
        {
            (7, 24),   // 168 px disc — most zoomed in
            (9, 18),   // 162 px
            (11, 13),  // 143 px — original fixed magnifier
            (15, 11),  // 165 px
            (21, 9),   // 189 px — most zoomed out (start)
        };
        // Start at the widest view (most zoomed out) per user request — shows the most
        // surrounding context; scroll up to zoom in on a single pixel.
        private int _zoomIndex = ZoomLevels.Length - 1;
        private int MagPixelCount => ZoomLevels[_zoomIndex].count;
        private int MagPixelSize => ZoomLevels[_zoomIndex].size;
        private int MagDiameter => MagPixelCount * MagPixelSize;
        private const int MagLabelGap = 8;
        // Three-line chip: X/Y coords + HEX + RGB. Must match the rendered height so the
        // flip-on-edge logic in DrawMagnifier + ComputeCursorLabelRect lands cleanly.
        private const int MagLabelHeight = 56;
        private const int MagOffset = 20;
        private int MagTotalHeight => MagDiameter + MagLabelGap + MagLabelHeight;

        // Fake drop shadow — GDI+ has no blur, so several low-alpha rings stacked at
        // growing radii accumulate into a soft falloff. Kept subtle so the disc/chip
        // read as lifted, not boxed. MagShadowMargin pads the invalidate rects so the
        // shadow clears cleanly as the cursor moves (no smear trails).
        private const int MagShadowSpread = 6;
        private const int MagShadowAlpha = 15;
        private const int MagShadowDy = 2;
        private const int MagShadowMargin = MagShadowSpread + MagShadowDy;

        // Approximates the magnifier's bounding box for OnMouseMove's invalidate. The
        // actual paint rect is captured back into _lastCursorLabelRect inside DrawMagnifier
        // so the next move invalidates exactly the touched pixels.
        private Rectangle ComputeCursorLabelRect()
        {
            if (!_hasCursor) return Rectangle.Empty;
            int lx = _cursorPoint.X + MagOffset;
            int ly = _cursorPoint.Y + MagOffset;
            if (lx + MagDiameter > ClientRectangle.Width)  lx = _cursorPoint.X - MagOffset - MagDiameter;
            if (ly + MagTotalHeight > ClientRectangle.Height) ly = _cursorPoint.Y - MagOffset - MagTotalHeight;
            if (lx < 0) lx = 0;
            if (ly < 0) ly = 0;
            // Pad by the drop-shadow spread so the move-invalidate clears the shadow too.
            return Rectangle.Inflate(new Rectangle(lx, ly, MagDiameter, MagTotalHeight),
                                     MagShadowMargin, MagShadowMargin);
        }

        // ShareX-style zoom magnifier. Renders an 11×11 patch of the in-memory
        // screenshot centred on the cursor, amplified ~13× with nearest-neighbour
        // so individual pixels are crisp squares. A crosshair points at the centre
        // pixel — the one the click will actually capture — and the absolute coords
        // sit in a chip below the disc.
        //
        // Used only in pointPick mode. The system cursor alone makes 1-pixel
        // colour-picking essentially a guessing game; this disc removes the
        // ambiguity (the user sees exactly which pixel will be sampled).
        private void DrawMagnifier(Graphics g)
        {
            if (!_hasCursor) return;
            int absX = _cursorPoint.X + _virtualOriginX;
            int absY = _cursorPoint.Y + _virtualOriginY;

            // Position with the same flip-on-edge rules as DrawCursorCoords. Total
            // box includes the label below; if the disc alone would clip, flip
            // vertically before the label clipping logic runs.
            int magX = _cursorPoint.X + MagOffset;
            int magY = _cursorPoint.Y + MagOffset;
            if (magX + MagDiameter > ClientRectangle.Width)
                magX = _cursorPoint.X - MagOffset - MagDiameter;
            if (magY + MagTotalHeight > ClientRectangle.Height)
                magY = _cursorPoint.Y - MagOffset - MagTotalHeight;
            if (magX < 0) magX = 0;
            if (magY < 0) magY = 0;

            var circleRect = new Rectangle(magX, magY, MagDiameter, MagDiameter);

            // Anti-alias every vector pass (shadow, disc, crosshair, centre cell, chip) and
            // ClearType the chip text — the jagged 1.5 px border / 2 px crosshair were the
            // main thing that read as "unfinished". The blit + pixel grid flip back to None
            // below so zoomed pixels stay hard-edged. DrawMagnifier is the last thing
            // OnPaint draws, so these modes don't need restoring.
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            // Soft drop shadow — lifts the disc off busy backgrounds so it reads as a
            // deliberate instrument rather than a screenshot artifact.
            using (var sh = new SolidBrush(Color.FromArgb(MagShadowAlpha, 0, 0, 0)))
                for (int s = MagShadowSpread; s >= 1; s--)
                    g.FillEllipse(sh, circleRect.X - s, circleRect.Y - s + MagShadowDy,
                                  circleRect.Width + 2 * s, circleRect.Height + 2 * s);

            // Dark backdrop so out-of-bounds source pixels (near screen edges) read
            // as "void" instead of garbage. Sub-pixel circle border softens the
            // clipped edge.
            using (var bg = new SolidBrush(Color.FromArgb(235, 18, 18, 18)))
                g.FillEllipse(bg, circleRect);

            // Clip to the disc, then blit the screenshot patch with
            // NearestNeighbour for pixel-perfect zoom (no smoothing).
            using (var clip = new GraphicsPath())
            {
                clip.AddEllipse(circleRect);
                g.SetClip(clip);

                // Blit + pixel grid must stay hard-edged — AA here would shimmer the grid
                // lines and soften the crisp pixel squares.
                g.SmoothingMode = SmoothingMode.None;

                int halfGrid = MagPixelCount / 2;
                var srcRect = new Rectangle(
                    _cursorPoint.X - halfGrid,
                    _cursorPoint.Y - halfGrid,
                    MagPixelCount, MagPixelCount);

                var oldInterp = g.InterpolationMode;
                var oldPixel = g.PixelOffsetMode;
                g.InterpolationMode = InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                try
                {
                    g.DrawImage(_screenshot, circleRect, srcRect, GraphicsUnit.Pixel);
                }
                finally
                {
                    g.InterpolationMode = oldInterp;
                    g.PixelOffsetMode = oldPixel;
                }

                // Faint grid between amplified pixels — half-alpha white so it sits
                // on top of any colour without dominating. Skipping the i=0 and
                // i=MagPixelCount edges (they land on the disc border anyway).
                using var gridPen = new Pen(Color.FromArgb(35, 255, 255, 255));
                for (int i = 1; i < MagPixelCount; i++)
                {
                    int gx = magX + i * MagPixelSize;
                    int gy = magY + i * MagPixelSize;
                    g.DrawLine(gridPen, gx, magY, gx, magY + MagDiameter);
                    g.DrawLine(gridPen, magX, gy, magX + MagDiameter, gy);
                }

                // Back to anti-aliased for the crosshair + centre cell (smooth vectors).
                g.SmoothingMode = SmoothingMode.AntiAlias;

                // Crosshair — accent-coloured lines through the centre, broken
                // around the centre pixel so the target colour stays visible.
                using var crossPen = new Pen(Color.FromArgb(200, 96, 205, 255), 2f);
                int pxCenterX = magX + MagDiameter / 2;
                int pxCenterY = magY + MagDiameter / 2;
                int gap = MagPixelSize / 2 + 2;
                g.DrawLine(crossPen, magX + 4, pxCenterY, pxCenterX - gap, pxCenterY);
                g.DrawLine(crossPen, pxCenterX + gap, pxCenterY, magX + MagDiameter - 4, pxCenterY);
                g.DrawLine(crossPen, pxCenterX, magY + 4, pxCenterX, pxCenterY - gap);
                g.DrawLine(crossPen, pxCenterX, pxCenterY + gap, pxCenterX, magY + MagDiameter - 4);

                // Highlight the exact target pixel — 1.5 px white outline around the
                // centre cell so the user can see which pixel the click will sample,
                // even when the underlying colour is white-ish.
                int halfPx = (MagPixelCount / 2) * MagPixelSize;
                // Dual stroke — a dark 3 px underlay then white 1.5 px on top — so the
                // target cell stays legible on both light and dark pixels (a lone white
                // outline used to vanish on white-ish colours).
                using (var centerDark = new Pen(Color.FromArgb(170, 0, 0, 0), 3f))
                    g.DrawRectangle(centerDark, magX + halfPx, magY + halfPx, MagPixelSize, MagPixelSize);
                using (var centerLight = new Pen(Color.White, 1.5f))
                    g.DrawRectangle(centerLight, magX + halfPx, magY + halfPx, MagPixelSize, MagPixelSize);

                g.ResetClip();
            }

            // Disc border — 1.5 px subtle white outside the clip so it doesn't
            // overlap with the centre highlight.
            using (var borderPen = new Pen(Color.FromArgb(140, 255, 255, 255), 1.5f))
                g.DrawEllipse(borderPen, circleRect);

            // Coord chip below the disc — TWO lines:
            //   1. "X: {absX}  Y: {absY}"  — always shown
            //   2. "#RRGGBB"               — pointPick (Wait Pixel) only. Region picks don't
            //      need the colour; suppress the line to keep the chip compact.
            string coordText = $"X: {absX}  Y: {absY}";
            bool showHex = _pointPick;
            Color? sampled = null;
            if (showHex
                && _cursorPoint.X >= 0 && _cursorPoint.X < _screenshot.Width
                && _cursorPoint.Y >= 0 && _cursorPoint.Y < _screenshot.Height)
            {
                sampled = _screenshot.GetPixel(_cursorPoint.X, _cursorPoint.Y);
            }
            string hexText = sampled.HasValue
                ? TrueReplayer.Services.PixelColorService.ToHex(sampled.Value)
                : "—";
            // RGB readout alongside HEX — PowerToys shows multiple formats; this is the second one.
            string rgbText = sampled.HasValue
                ? $"RGB  {sampled.Value.R}, {sampled.Value.G}, {sampled.Value.B}"
                : "";

            // Monospace coords so the chip width stops jumping per-digit as the cursor moves.
            using var coordFont = new Font("Consolas", 10f, FontStyle.Regular);
            using var hexFont = new Font("Consolas", 10.5f, FontStyle.Bold);
            using var rgbFont = new Font("Consolas", 9f, FontStyle.Regular);
            var coordSize = g.MeasureString(coordText, coordFont);
            var hexSize = showHex ? g.MeasureString(hexText, hexFont) : SizeF.Empty;
            var rgbSize = (showHex && rgbText.Length > 0) ? g.MeasureString(rgbText, rgbFont) : SizeF.Empty;

            // Colour swatch to the left of the HEX line — the signature "real eyedropper"
            // element (ShareX/PowerToys both show it). pointPick only, so gated on showHex.
            const float swatch = 12f, swGap = 6f;
            bool showSwatch = showHex && sampled.HasValue;
            float hexGroupW = showSwatch ? swatch + swGap + hexSize.Width : hexSize.Width;

            // Chip sized per content — full (3-line) height when picking colour, compact
            // otherwise. The HEX row width now includes the swatch group.
            float chipW = Math.Max(coordSize.Width, Math.Max(hexGroupW, rgbSize.Width)) + 16;
            float chipH = showHex ? MagLabelHeight : (coordSize.Height + 6);
            float chipX = magX + (MagDiameter - chipW) / 2;
            float chipY = magY + MagDiameter + MagLabelGap;

            // Match the disc — a soft shadow lifts the chip too (radius grows with the ring).
            using (var chipShadow = new SolidBrush(Color.FromArgb(MagShadowAlpha, 0, 0, 0)))
                for (int s = MagShadowSpread; s >= 1; s--)
                    g.FillRoundedRectangle(chipShadow, chipX - s, chipY - s + MagShadowDy,
                                           chipW + 2 * s, chipH + 2 * s, 5 + s);

            using (var chipBg = new SolidBrush(Color.FromArgb(225, 0, 0, 0)))
                g.FillRoundedRectangle(chipBg, chipX, chipY, chipW, chipH, 5);
            using (var chipFg = new SolidBrush(Color.FromArgb(255, 96, 205, 255)))
            using (var rgbFg = new SolidBrush(Color.FromArgb(210, 197, 197, 197)))
            {
                float coordX = chipX + (chipW - coordSize.Width) / 2;
                g.DrawString(coordText, coordFont, chipFg, coordX, chipY + 3);
                if (showHex)
                {
                    float hexY = chipY + 3 + coordSize.Height + 1;
                    float groupX = chipX + (chipW - hexGroupW) / 2;
                    float hexX = groupX;
                    if (showSwatch)
                    {
                        float swY = hexY + (hexSize.Height - swatch) / 2f;
                        using (var swBrush = new SolidBrush(Color.FromArgb(255, sampled!.Value.R, sampled.Value.G, sampled.Value.B)))
                            g.FillRectangle(swBrush, groupX, swY, swatch, swatch);
                        using (var swBorder = new Pen(Color.FromArgb(170, 255, 255, 255), 1f))
                            g.DrawRectangle(swBorder, groupX, swY, swatch, swatch);
                        hexX = groupX + swatch + swGap;
                    }
                    g.DrawString(hexText, hexFont, chipFg, hexX, hexY);
                    if (rgbText.Length > 0)
                    {
                        float rgbX = chipX + (chipW - rgbSize.Width) / 2;
                        g.DrawString(rgbText, rgbFont, rgbFg, rgbX, hexY + hexSize.Height + 1);
                    }
                }
            }

            // Tracked rect = whole magnifier + label, padded by the drop-shadow spread so
            // the next move invalidates the shadow pixels too. Used by OnMouseMove to
            // invalidate the previous frame; without it the disc would smear.
            _lastCursorLabelRect = Rectangle.Inflate(
                new Rectangle(magX, magY, MagDiameter, MagTotalHeight), MagShadowMargin, MagShadowMargin);
        }

        private void OnMouseUp(object? sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && _isDragging)
            {
                _isDragging = false;
                _currentPoint = e.Location;
                _hasSelection = true;

                var rect = GetSelectionRect();
                if (rect.Width < 10 || rect.Height < 10)
                {
                    // Too small, reset
                    _hasSelection = false;
                    Invalidate();
                    return;
                }

                // Account for virtual screen offset — reuse the origin cached in the ctor instead
                // of re-querying GetSystemMetrics.
                int vx = _virtualOriginX;
                int vy = _virtualOriginY;

                Bitmap? cropped = null;
                if (!_regionOnly)
                {
                    cropped = new Bitmap(rect.Width, rect.Height);
                    using var g = Graphics.FromImage(cropped);
                    g.DrawImage(_screenshot, 0, 0, rect, GraphicsUnit.Pixel);
                }

                var result = new RegionSelectionResult
                {
                    CroppedImage = cropped,
                    ScreenX = rect.X + vx,
                    ScreenY = rect.Y + vy,
                    Width = rect.Width,
                    Height = rect.Height
                };

                _tcs.TrySetResult(result);
                Close();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _screenshot?.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    // Extension method for rounded rectangles
    internal static class GraphicsExtensions
    {
        public static void FillRoundedRectangle(this Graphics g, Brush brush, float x, float y, float w, float h, float r)
        {
            using var path = new GraphicsPath();
            path.AddArc(x, y, r * 2, r * 2, 180, 90);
            path.AddArc(x + w - r * 2, y, r * 2, r * 2, 270, 90);
            path.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0, 90);
            path.AddArc(x, y + h - r * 2, r * 2, r * 2, 90, 90);
            path.CloseFigure();
            g.FillPath(brush, path);
        }
    }
}
