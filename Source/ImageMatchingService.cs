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
        ///
        /// Public for callers that poll the SAME reference image many times and therefore hoist the
        /// Bitmap→Mat conversion out of their loop (WaitForImageAsync above; the automation
        /// daemon's ImageFound watcher). That conversion is a LockBits plus a BGRA→BGR CvtColor into
        /// a freshly allocated native Mat, and the template cannot change while a loop is running.
        /// One-shot callers should use the Bitmap overload above instead.
        ///
        /// With a usable region only that sub-rectangle is captured from the screen; the old flow
        /// grabbed the ENTIRE virtual desktop per call and cropped a sub-Mat out of it, so an
        /// ROI-constrained poll still paid the full-screen capture on every tick. An unusable
        /// region returns NOT FOUND before anything is captured at all.
        /// </summary>
        /// <param name="reportUnusableRegion">
        /// Log a line when the search region can't be applied. The polling caller sets this on
        /// the first iteration only; single-shot callers always pass true.
        /// </param>
        public static MatchResult MatchOnce(Mat templateMat, System.Drawing.Rectangle? searchRegion, bool reportUnusableRegion)
        {
            // Callers pass searchRegion in ABSOLUTE virtual-screen coords (that's what the overlay
            // form reports), while captured bitmaps index from (0,0) at the virtual-screen origin
            // (vx, vy) — so the region math below subtracts the origin before clamping, and the
            // returned match coords add it back. Otherwise multi-monitor setups with vx ≠ 0 would
            // crop the wrong slice (and the test-match score would tank to noise levels).
            // Cached bounds — saves P/Invokes per match attempt (WaitImage polls at 500 ms, so a
            // few seconds of waiting was hitting GetSystemMetrics dozens of times), and it is the
            // SAME cache CaptureVirtualScreen reads, so origin and full-screen capture stay
            // consistent by construction. See NativeMethods.VirtualScreen.
            var (vx, vy, vw, vh) = NativeMethods.VirtualScreen.Bounds;

            int offsetX = 0;
            int offsetY = 0;
            // Capture is DEFERRED until the region has been validated: the region branch grabs
            // only its sub-rectangle, the region-less branch grabs the whole virtual screen, and
            // an unusable region returns before either. Whichever branch filled them, both are
            // released in the finally.
            Bitmap? screenBitmap = null;
            Mat? screenMat = null;
            try
            {
                if (searchRegion is { } region)
                {
                    int rxBitmap = region.X - vx;
                    int ryBitmap = region.Y - vy;
                    // Region may extend off the screen on either side — clamp the start to the
                    // desktop bounds and shrink width/height by however much was clipped at the
                    // left/top edge. Clamped against the CACHED size (vw, vh) — nothing has been
                    // captured yet at this point.
                    int rx = Math.Max(0, rxBitmap);
                    int ry = Math.Max(0, ryBitmap);
                    int rw = Math.Min(vw - rx, region.Width - (rx - rxBitmap));
                    int rh = Math.Min(vh - ry, region.Height - (ry - ryBitmap));

                    // >=, not >: Cv2.MatchTemplate accepts a template exactly as large as the
                    // image it searches (the correlation map is then 1x1). An ROI drawn snugly
                    // around the template — or clipped down to exactly that size by a screen
                    // edge — is a perfectly valid single-position search, and the old strict
                    // comparison threw it away.
                    if (rw >= templateMat.Width && rh >= templateMat.Height)
                    {
                        offsetX = rx;
                        offsetY = ry;
                        // Capture ONLY the validated sub-rectangle (back in absolute coords).
                        // The crop happened at capture time, so no sub-Mat is needed — and an
                        // ROI-constrained poll no longer pays for a full-desktop grab per tick.
                        screenBitmap = ScreenCaptureService.CaptureRegion(rx + vx, ry + vy, rw, rh);
                        screenMat = ScreenCaptureService.BitmapToMat(screenBitmap);
                    }
                    else
                    {
                        // An unusable region is NOT-FOUND, never a full-screen search — and it is
                        // decided BEFORE any capture, so an off-desktop region costs nothing per poll.
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
                                $"(usable {rw}x{rh} after clipping to the {vw}x{vh} desktop at " +
                                $"({vx},{vy})) — reporting NOT FOUND. A negative size means the region is off-desktop, " +
                                "e.g. recorded on a monitor that is no longer connected.");
                        }
                        return new MatchResult(0, 0, 0, templateMat.Width, templateMat.Height);
                    }
                }
                else
                {
                    screenBitmap = ScreenCaptureService.CaptureVirtualScreen();
                    screenMat = ScreenCaptureService.BitmapToMat(screenBitmap);
                }

                // Cv2.MatchTemplate throws if the template is larger than the image being searched
                // in either dimension. With a region this is already handled above; what remains
                // is the region-less full-screen search, where a reference image captured on a
                // larger / multi-monitor desktop is replayed on a smaller screen (or after a
                // monitor is unplugged). Treat it as "not found" (Score 0) so the action runs its
                // normal timeout / OnTimeout handling instead of throwing an unobserved exception
                // that aborts the whole replay run.
                if (screenMat.Width < templateMat.Width || screenMat.Height < templateMat.Height)
                    return new MatchResult(0, 0, 0, templateMat.Width, templateMat.Height);

                using var matchResult = new Mat();
                Cv2.MatchTemplate(screenMat, templateMat, matchResult, TemplateMatchModes.CCoeffNormed);
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
                screenMat?.Dispose();
                screenBitmap?.Dispose();
            }
        }
    }
}
