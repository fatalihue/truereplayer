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
    }

    public class ScreenOverlayForm : Form
    {
        private readonly Bitmap _screenshot;
        private readonly bool _regionOnly;
        private readonly bool _pointPick;
        private readonly string _hintText;
        private readonly TaskCompletionSource<RegionSelectionResult?> _tcs = new();

        private Point _startPoint;
        private Point _currentPoint;
        private bool _isDragging;
        private bool _hasSelection;
        // Live cursor position used to render an "(x, y)" label next to the mouse — like
        // ShareX / Greenshot. Lets the user see the exact coords they'll capture before
        // committing. Updated on every MouseMove regardless of drag state.
        private Point _cursorPoint;
        private bool _hasCursor;
        // Last painted label rect, used to do a targeted invalidate (old ∪ new) instead of
        // a full-form invalidate on every MouseMove — that would mean repainting a virtual-
        // screen-sized bitmap at mouse-event frequency, which is brutal on multi-monitor.
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
        public ScreenOverlayForm(Bitmap screenshot, bool regionOnly = false, bool pointPick = false, string? hintText = null)
        {
            _screenshot = screenshot;
            _regionOnly = regionOnly;
            _pointPick = pointPick;
            _hintText = hintText ?? (pointPick
                ? "Click anywhere to pick a position  •  ESC to cancel"
                : "Click and drag to select a region  •  ESC to cancel");

            // Virtual screen bounds (all monitors)
            int vx = NativeMethods.GetSystemMetrics(76);
            int vy = NativeMethods.GetSystemMetrics(77);
            int vw = NativeMethods.GetSystemMetrics(78);
            int vh = NativeMethods.GetSystemMetrics(79);
            _virtualOriginX = vx;
            _virtualOriginY = vy;

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
        }

        public Task<RegionSelectionResult?> GetSelectionAsync() => _tcs.Task;

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

            // Instruction text at top center
            if (!_isDragging && !_hasSelection)
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

            // Cursor coord callout — drawn last so it sits above the overlay tint and any
            // selection rect. Skipped once a selection is committed (hasSelection && !drag)
            // because the click already landed and the value is captured.
            if (!_hasSelection || _isDragging)
            {
                DrawCursorCoords(g);
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
                    _tcs.TrySetResult(new RegionSelectionResult
                    {
                        CroppedImage = null,
                        ScreenX = e.Location.X + _virtualOriginX,
                        ScreenY = e.Location.Y + _virtualOriginY,
                        Width = 0,
                        Height = 0,
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

            // Not dragging — only the cursor coord HUD changed. Invalidate just the union
            // of the old and new label rects so we redraw a few hundred px instead of the
            // entire virtual-screen-sized form.
            var newRect = ComputeCursorLabelRect();
            var dirty = _lastCursorLabelRect.IsEmpty ? newRect : Rectangle.Union(_lastCursorLabelRect, newRect);
            // Inflate by 1 to guarantee anti-aliased edges aren't left behind.
            dirty.Inflate(1, 1);
            _lastCursorLabelRect = newRect;
            Invalidate(dirty);
        }

        // Mirrors the geometry in DrawCursorCoords so the dirty-rect logic in OnMouseMove
        // stays in sync. Uses a fixed font metric estimate to avoid creating a Graphics
        // context outside paint — close enough since the inflate(1) absorbs sub-pixel drift.
        private Rectangle ComputeCursorLabelRect()
        {
            if (!_hasCursor) return Rectangle.Empty;
            int absX = _cursorPoint.X + _virtualOriginX;
            int absY = _cursorPoint.Y + _virtualOriginY;
            string text = $"{absX}, {absY}";
            // Approximation: Segoe UI 9.5 averages ~6.5 px/char wide, ~14 px tall. Add the
            // pad (6 horizontal, 3 vertical * 2) used in DrawCursorCoords.
            int labelW = (int)Math.Ceiling(text.Length * 6.5f) + 12;
            int labelH = 14 + 6;
            int lx = _cursorPoint.X + 16;
            int ly = _cursorPoint.Y + 16;
            if (lx + labelW > ClientRectangle.Width)  lx = _cursorPoint.X - 16 - labelW;
            if (ly + labelH > ClientRectangle.Height) ly = _cursorPoint.Y - 16 - labelH;
            if (lx < 0) lx = 0;
            if (ly < 0) ly = 0;
            return new Rectangle(lx, ly, labelW, labelH);
        }

        // Renders an "(x, y)" callout near the cursor showing the absolute virtual-screen
        // coordinates (i.e. what the action will actually store). Inspired by ShareX /
        // Greenshot — small, high-contrast, follows the cursor, flips to the opposite side
        // when too close to an edge so it never gets clipped.
        private void DrawCursorCoords(Graphics g)
        {
            if (!_hasCursor) return;
            int absX = _cursorPoint.X + _virtualOriginX;
            int absY = _cursorPoint.Y + _virtualOriginY;
            string text = $"{absX}, {absY}";
            using var font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            var size = g.MeasureString(text, font);
            // Default offset: 16px down-right of cursor (out of the way of the click target).
            // Flip horizontally / vertically if we'd run off the form.
            float padX = 6, padY = 3;
            float labelW = size.Width + padX * 2;
            float labelH = size.Height + padY * 2;
            float lx = _cursorPoint.X + 16;
            float ly = _cursorPoint.Y + 16;
            if (lx + labelW > ClientRectangle.Width)  lx = _cursorPoint.X - 16 - labelW;
            if (ly + labelH > ClientRectangle.Height) ly = _cursorPoint.Y - 16 - labelH;
            if (lx < 0) lx = 0;
            if (ly < 0) ly = 0;
            using var bg = new SolidBrush(Color.FromArgb(220, 0, 0, 0));
            g.FillRoundedRectangle(bg, lx, ly, labelW, labelH, 4);
            using var fg = new SolidBrush(Color.FromArgb(255, 96, 205, 255)); // #60CDFF accent
            g.DrawString(text, font, fg, lx + padX, ly + padY);
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

                // Account for virtual screen offset
                int vx = NativeMethods.GetSystemMetrics(76);
                int vy = NativeMethods.GetSystemMetrics(77);

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
