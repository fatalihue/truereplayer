using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using OpenCvSharp;
using TrueReplayer.Interop;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Outcome of a template-match attempt. Coordinates are absolute on the virtual screen,
    /// even when a <see cref="System.Drawing.Rectangle"/> search region was used — callers
    /// (like "click on found") can use X/Y/W/H directly without re-offsetting.
    /// </summary>
    public record MatchResult(double Score, int X, int Y, int W, int H);

    public static class ImageMatchingService
    {
        /// <summary>
        /// Repeatedly captures the screen and searches for the template image.
        /// Returns the match details if the condition is met, or null on timeout.
        ///
        /// <paramref name="waitForDisappear"/> inverts the polling condition: when true, the
        /// method returns as soon as the best match falls BELOW <paramref name="confidenceThreshold"/>.
        ///
        /// <paramref name="searchRegion"/> (absolute screen coords) constrains the match to a
        /// sub-rectangle of the virtual screen — reduces CPU and false positives. null = full screen.
        /// </summary>
        public static async Task<MatchResult?> WaitForImageAsync(
            Bitmap referenceImage,
            double confidenceThreshold,
            int timeoutMs,
            CancellationToken cancellationToken,
            bool waitForDisappear = false,
            System.Drawing.Rectangle? searchRegion = null,
            int pollIntervalMs = 500)
        {
            using var templateMat = ScreenCaptureService.BitmapToMat(referenceImage);
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

            while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                var result = MatchOnce(templateMat, searchRegion);
                bool matched = waitForDisappear
                    ? result.Score < confidenceThreshold
                    : result.Score >= confidenceThreshold;

                if (matched) return result;

                try
                {
                    await Task.Delay(pollIntervalMs, cancellationToken);
                }
                catch (TaskCanceledException)
                {
                    break;
                }
            }

            return null;
        }

        /// <summary>
        /// Single-shot match against the current screen. Used by the "Test match" calibration
        /// button in the editor (no polling, no timeout — just one capture + compare).
        /// </summary>
        public static MatchResult MatchOnce(Bitmap referenceImage, System.Drawing.Rectangle? searchRegion = null)
        {
            using var templateMat = ScreenCaptureService.BitmapToMat(referenceImage);
            return MatchOnce(templateMat, searchRegion);
        }

        private static MatchResult MatchOnce(Mat templateMat, System.Drawing.Rectangle? searchRegion)
        {
            using var screenBitmap = ScreenCaptureService.CaptureVirtualScreen();
            using var screenMat = ScreenCaptureService.BitmapToMat(screenBitmap);

            // The bitmap returned by CaptureVirtualScreen starts at (0,0) but corresponds to the
            // virtual screen origin (vx, vy). Callers pass searchRegion in ABSOLUTE virtual-screen
            // coords (that's what the overlay form reports), so we must subtract (vx, vy) before
            // indexing into the bitmap — otherwise multi-monitor setups with vx ≠ 0 would crop
            // the wrong slice (and the test-match score would tank to noise levels).
            // Cached virtual-screen origin — saves 2 P/Invokes per match attempt
            // (WaitImage polls at 500 ms, so a few seconds of waiting was hitting
            // GetSystemMetrics dozens of times). See NativeMethods.VirtualScreen.
            var (vx, vy, _, _) = NativeMethods.VirtualScreen.Bounds;

            int offsetX = 0;
            int offsetY = 0;
            Mat workingMat = screenMat;
            Mat? croppedMat = null;
            try
            {
                if (searchRegion is { } region)
                {
                    int rxBitmap = region.X - vx;
                    int ryBitmap = region.Y - vy;
                    // Region may extend off the screen on either side — clamp the start to the
                    // bitmap bounds and shrink width/height by however much was clipped at the
                    // left/top edge.
                    int rx = Math.Max(0, rxBitmap);
                    int ry = Math.Max(0, ryBitmap);
                    int rw = Math.Min(screenMat.Width - rx, region.Width - (rx - rxBitmap));
                    int rh = Math.Min(screenMat.Height - ry, region.Height - (ry - ryBitmap));
                    if (rw > templateMat.Width && rh > templateMat.Height)
                    {
                        offsetX = rx;
                        offsetY = ry;
                        croppedMat = new Mat(screenMat, new OpenCvSharp.Rect(rx, ry, rw, rh));
                        workingMat = croppedMat;
                    }
                    // else: region too small for the template, fall through to full-screen match
                }

                using var matchResult = new Mat();
                Cv2.MatchTemplate(workingMat, templateMat, matchResult, TemplateMatchModes.CCoeffNormed);
                Cv2.MinMaxLoc(matchResult, out _, out double maxVal, out _, out var maxLoc);
                // Convert back: bitmap (maxLoc + offset) → absolute virtual-screen (add vx/vy)
                // so the caller (click-on-match, test-match display) speaks the same coord system
                // the overlay form reports.
                return new MatchResult(
                    maxVal,
                    maxLoc.X + offsetX + vx,
                    maxLoc.Y + offsetY + vy,
                    templateMat.Width,
                    templateMat.Height);
            }
            finally
            {
                croppedMat?.Dispose();
            }
        }
    }
}
