using System;
using System.Drawing;
using System.Drawing.Imaging;
using OpenCvSharp;
using TrueReplayer.Interop;

namespace TrueReplayer.Services
{
    public static class ScreenCaptureService
    {
        /// <summary>
        /// Captures the entire virtual screen (all monitors) as a Bitmap.
        /// </summary>
        public static Bitmap CaptureVirtualScreen()
        {
            // Read the SAME cached bounds ImageMatchingService uses, not GetSystemMetrics directly.
            // These are one value conceptually, and nothing made the two sources agree: the cache
            // is invalidated on WM_DISPLAYCHANGE, which is handled on the UI thread, while a
            // WaitImage poll runs on the pool. In the window between the arrangement changing and
            // that message being pumped, the bitmap was captured against the NEW origin and the
            // match translated back with the OLD one — so the hit came out shifted by the delta,
            // typically a full monitor width. Sharing the cache makes them consistent by
            // construction instead of by timing.
            var (x, y, w, h) = NativeMethods.VirtualScreen.Bounds;

            // Use managed Bitmap + Graphics.CopyFromScreen to avoid GDI handle leaks.
            // The previous approach (CreateDC/CreateCompatibleBitmap/Image.FromHbitmap)
            // leaked GDI handles and could exhaust system resources, crashing explorer.exe.
            var bitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h), CopyPixelOperation.SourceCopy);
            }
            return bitmap;
        }

        /// <summary>
        /// Converts a System.Drawing.Bitmap to an OpenCvSharp Mat (BGR format).
        /// </summary>
        public static Mat BitmapToMat(Bitmap bitmap)
        {
            var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            var bmpData = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);

            try
            {
                using var mat = Mat.FromPixelData(bitmap.Height, bitmap.Width, MatType.CV_8UC4, bmpData.Scan0);
                var bgr = new Mat();
                try
                {
                    Cv2.CvtColor(mat, bgr, ColorConversionCodes.BGRA2BGR);
                }
                catch
                {
                    // Don't leak the destination Mat (native memory) if the colour convert throws.
                    bgr.Dispose();
                    throw;
                }
                return bgr;
            }
            finally
            {
                bitmap.UnlockBits(bmpData);
            }
        }
    }
}
