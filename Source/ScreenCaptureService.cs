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
            int x = NativeMethods.GetSystemMetrics(76);  // SM_XVIRTUALSCREEN
            int y = NativeMethods.GetSystemMetrics(77);  // SM_YVIRTUALSCREEN
            int w = NativeMethods.GetSystemMetrics(78);  // SM_CXVIRTUALSCREEN
            int h = NativeMethods.GetSystemMetrics(79);  // SM_CYVIRTUALSCREEN

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
                var mat = Mat.FromPixelData(bitmap.Height, bitmap.Width, MatType.CV_8UC4, bmpData.Scan0);
                var bgr = new Mat();
                Cv2.CvtColor(mat, bgr, ColorConversionCodes.BGRA2BGR);
                mat.Dispose();
                return bgr;
            }
            finally
            {
                bitmap.UnlockBits(bmpData);
            }
        }
    }
}
