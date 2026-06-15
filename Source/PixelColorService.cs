using System;
using System.Diagnostics;
using System.Drawing;
using TrueReplayer.Interop;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Single-pixel colour sampling for the WaitPixelColor action. Lives next to the
    /// existing ImageMatchingService but is intentionally much lighter — no OpenCV, no
    /// PNG, no template walk. One <c>GetPixel</c> call per poll (~0.1 ms) so the replay
    /// loop can comfortably tick at 20 Hz without measurable CPU.
    ///
    /// All public methods are static and side-effect-free: nothing is cached between
    /// calls. GDI handles are acquired and released within each <see cref="GetPixelAt"/>
    /// call rather than holding a long-lived DC, because long-lived DCs leak GDI objects
    /// when the desktop session changes (RDP reconnect, user switch) and cost ~zero per
    /// acquire/release pair on a healthy system.
    /// </summary>
    public static class PixelColorService
    {
        // Sentinel returned by GetPixel when the requested coordinates fall outside any
        // visible monitor or the DC can't serve the read (e.g. some DirectX fullscreen
        // exclusive apps deny GDI reads of their backbuffer). Callers treat this as
        // "no colour available" rather than as a literal pure-white pixel.
        private const uint CLR_INVALID = 0xFFFFFFFF;

        /// <summary>
        /// Reads the colour of a screen pixel at absolute (virtual-desktop) coordinates.
        /// Multi-monitor works automatically — the desktop DC spans every visible monitor,
        /// so the same X/Y pair that drives a SimulateMouse click also drives the read.
        /// Returns <c>null</c> when the pixel can't be sampled (out of bounds or accelerated
        /// surface); WaitPixelColor treats null as a non-match so the replay falls through
        /// to its timeout behaviour instead of crashing.
        /// </summary>
        public static Color? GetPixelAt(int x, int y)
        {
            IntPtr hdc = NativeMethods.GetDC(IntPtr.Zero);
            if (hdc == IntPtr.Zero)
            {
                Debug.WriteLine("[PixelColorService] GetDC(NULL) returned IntPtr.Zero");
                return null;
            }
            try
            {
                uint colorRef = NativeMethods.GetPixel(hdc, x, y);
                if (colorRef == CLR_INVALID) return null;

                // COLORREF is 0x00BBGGRR (low byte = R) — invert when handing to Color.FromArgb,
                // which takes R/G/B in their natural order.
                int r = (int)(colorRef & 0xFF);
                int g = (int)((colorRef >> 8) & 0xFF);
                int b = (int)((colorRef >> 16) & 0xFF);
                return Color.FromArgb(r, g, b);
            }
            finally
            {
                NativeMethods.ReleaseDC(IntPtr.Zero, hdc);
            }
        }

        /// <summary>
        /// Whether two colours match within a per-channel tolerance band. Tolerance is
        /// applied independently to R, G, and B (Manhattan on each axis) rather than as a
        /// Euclidean distance in RGB space — users reason in "give or take 10 per channel"
        /// terms, and per-channel matches what they see in pixel-picker tools like ShareX.
        /// Tolerance 0 demands an exact match. Negative values are clamped to 0 so a
        /// fat-finger doesn't silently disable matching.
        /// </summary>
        public static bool MatchesWithinTolerance(Color sampled, Color target, int tolerance)
        {
            if (tolerance < 0) tolerance = 0;
            return Math.Abs(sampled.R - target.R) <= tolerance
                && Math.Abs(sampled.G - target.G) <= tolerance
                && Math.Abs(sampled.B - target.B) <= tolerance;
        }

        /// <summary>
        /// Parses "#RRGGBB" or "RRGGBB" (case-insensitive) into a Color. Returns null on
        /// any kind of malformed input — wrong length, non-hex chars, null/whitespace.
        /// WaitPixelColor treats null as "no target colour set", which surfaces as an
        /// immediate timeout instead of a crashed replay loop. Three-digit shorthand
        /// (#FFF) is NOT supported — the editor always saves the expanded form so we
        /// don't need lossy parsing here.
        /// </summary>
        public static Color? ParseHex(string? hex)
        {
            if (string.IsNullOrWhiteSpace(hex)) return null;

            string s = hex.Trim();
            if (s.StartsWith("#")) s = s.Substring(1);
            if (s.Length != 6) return null;
            // Reject anything that isn't a pure hex triple — Convert.ToInt32(..,16) otherwise
            // silently accepts a leading sign/whitespace in a channel (e.g. "+f0000").
            foreach (char c in s) if (!Uri.IsHexDigit(c)) return null;

            try
            {
                int r = Convert.ToInt32(s.Substring(0, 2), 16);
                int g = Convert.ToInt32(s.Substring(2, 2), 16);
                int b = Convert.ToInt32(s.Substring(4, 2), 16);
                return Color.FromArgb(r, g, b);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Renders a Color as "#RRGGBB" uppercase. Convenience for the bridge handlers that
        /// echo a sampled colour back to the React editor (eyedropper result, test-match
        /// feedback) — keeps the wire format consistent with what <see cref="ParseHex"/>
        /// accepts.
        /// </summary>
        public static string ToHex(Color color)
        {
            return $"#{color.R:X2}{color.G:X2}{color.B:X2}";
        }
    }
}
