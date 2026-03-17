using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using OpenCvSharp;

namespace TrueReplayer.Services
{
    public static class ImageMatchingService
    {
        /// <summary>
        /// Repeatedly captures the screen and searches for the template image.
        /// Returns the match location if found, or null if timed out.
        /// </summary>
        public static async Task<System.Drawing.Point?> WaitForImageAsync(
            Bitmap referenceImage,
            double confidenceThreshold,
            int timeoutMs,
            CancellationToken cancellationToken,
            int pollIntervalMs = 500)
        {
            using var templateMat = ScreenCaptureService.BitmapToMat(referenceImage);
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

            while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                using var screenBitmap = ScreenCaptureService.CaptureVirtualScreen();
                using var screenMat = ScreenCaptureService.BitmapToMat(screenBitmap);
                using var result = new Mat();

                Cv2.MatchTemplate(screenMat, templateMat, result, TemplateMatchModes.CCoeffNormed);
                Cv2.MinMaxLoc(result, out _, out double maxVal, out _, out var maxLoc);

                if (maxVal >= confidenceThreshold)
                {
                    return new System.Drawing.Point(maxLoc.X, maxLoc.Y);
                }

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
    }
}
