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
        /// A region that can't be applied (smaller than the template, or off the current desktop)
        /// reports NOT FOUND rather than quietly widening the search — see MatchOnce.
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

            // Only the FIRST poll may report an unusable search region. The region is fixed for
            // the whole call, so the verdict can't change between iterations — without this a
            // 30 s WaitImage polling at 500 ms would write the same warning 60 times.
            bool reportRegion = true;

            while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                var result = MatchOnce(templateMat, searchRegion, reportRegion);
                reportRegion = false;
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
            return MatchOnce(templateMat, searchRegion, reportUnusableRegion: true);
        }

        /// <summary>
        /// One capture + one template match, optionally restricted to a search region.
        /// </summary>
        /// <param name="reportUnusableRegion">
        /// Log a line when the search region can't be applied. The polling caller sets this on
        /// the first iteration only; single-shot callers always pass true.
        /// </param>
        private static MatchResult MatchOnce(Mat templateMat, System.Drawing.Rectangle? searchRegion, bool reportUnusableRegion)
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

                    // >=, not >: Cv2.MatchTemplate accepts a template exactly as large as the
                    // image it searches (the correlation map is then 1x1). An ROI drawn snugly
                    // around the template — or clipped down to exactly that size by a screen
                    // edge — is a perfectly valid single-position search, and the old strict
                    // comparison threw it away.
                    if (rw >= templateMat.Width && rh >= templateMat.Height)
                    {
                        offsetX = rx;
                        offsetY = ry;
                        croppedMat = new Mat(screenMat, new OpenCvSharp.Rect(rx, ry, rw, rh));
                        workingMat = croppedMat;
                    }
                    else
                    {
                        // An unusable region is NOT-FOUND, never a full-screen search.
                        //
                        // This branch catches two different situations and the old fall-through
                        // handled both by widening the hunt to the entire virtual desktop, which
                        // is the exact opposite of what drawing an ROI asks for:
                        //   • the region is genuinely smaller than the template (misdrawn ROI);
                        //   • the region is no longer ON this desktop. A rect recorded on a
                        //     secondary monitor that has since been unplugged clamps to rx=0 and
                        //     then yields a NEGATIVE rw — e.g. region (-1700,300,400,300) on a
                        //     lone 1920x1080 primary gives rw = Min(1920, 400-1700) = -1300.
                        // In the second case the ROI is the only thing pinning the search to one
                        // monitor, so widening it hands the caller a match from anywhere. With
                        // WaitImage's "click on match" on, that score-above-threshold hit turns
                        // straight into a real click at an arbitrary screen position, mid-macro.
                        //
                        // Score 0 = not found, so the action runs its normal timeout / OnTimeout
                        // policy. (Wait-for-DISAPPEAR reads score 0 as "gone" — same as the
                        // template-too-large guard below already does — but that mode can't
                        // click, so it can only end the wait early, never move the mouse.)
                        if (reportUnusableRegion)
                        {
                            DiagnosticLog.Warn(
                                $"[ImageMatch] Search region {region.Width}x{region.Height} at ({region.X},{region.Y}) " +
                                $"is unusable for a {templateMat.Width}x{templateMat.Height} template " +
                                $"(usable {rw}x{rh} after clipping to the {screenMat.Width}x{screenMat.Height} desktop at " +
                                $"({vx},{vy})) — reporting NOT FOUND. A negative size means the region is off-desktop, " +
                                "e.g. recorded on a monitor that is no longer connected.");
                        }
                        return new MatchResult(0, 0, 0, templateMat.Width, templateMat.Height);
                    }
                }

                // Cv2.MatchTemplate throws if the template is larger than the image being searched
                // in either dimension. With a region this is already handled above; what remains
                // is the region-less full-screen search, where a reference image captured on a
                // larger / multi-monitor desktop is replayed on a smaller screen (or after a
                // monitor is unplugged). Treat it as "not found" (Score 0) so the action runs its
                // normal timeout / OnTimeout handling instead of throwing an unobserved exception
                // that aborts the whole replay run.
                if (workingMat.Width < templateMat.Width || workingMat.Height < templateMat.Height)
                    return new MatchResult(0, 0, 0, templateMat.Width, templateMat.Height);

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
