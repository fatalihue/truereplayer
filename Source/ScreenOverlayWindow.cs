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
                    int vx = NativeMethods.GetSystemMetrics(76);
                    int vy = NativeMethods.GetSystemMetrics(77);
                    _tcs.TrySetResult(new RegionSelectionResult
                    {
                        CroppedImage = null,
                        ScreenX = e.Location.X + vx,
                        ScreenY = e.Location.Y + vy,
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
            if (_isDragging)
            {
                _currentPoint = e.Location;
                Invalidate();
            }
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
