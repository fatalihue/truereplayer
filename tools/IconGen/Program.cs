// Generates TrueReplayer.ico (green), TrueReplayerRed.ico (red), TrueReplayerPurple.ico (purple)
// from a high-resolution source PNG. Each .ico embeds multiple resolutions (16, 24, 32, 48, 64, 128, 256)
// stored as PNG (Vista+ format) for crisper rendering at every size.
//
// Tinting: blend(original, grayscale*tintColor, strength) preserves the silhouette/details of the source
// art while applying the requested hue. A circular alpha mask matches the existing tile asset shape so
// the .ico reads as a circular badge rather than a square crop.

using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

#pragma warning disable CA1416 // System.Drawing.Common is Windows-only — this is a Windows tool.

string source = args.Length > 0 ? args[0] : "Assets/Square310x310Logo.png";
string outDir = args.Length > 1 ? args[1] : ".";

Console.WriteLine($"Source: {Path.GetFullPath(source)}");
Console.WriteLine($"Output dir: {Path.GetFullPath(outDir)}");

using var src = (Bitmap)Image.FromFile(source);
Console.WriteLine($"Source size: {src.Width}x{src.Height}");

int[] sizes = { 16, 24, 32, 48, 64, 128, 256 };

// Strength = 0 keeps the original art untouched (only the circular mask is applied).
// Higher strength pushes the image further toward the tint color.
(string Name, double R, double G, double B, double Strength)[] variants = {
    ("TrueReplayer",       1.00, 1.00, 1.00, 0.00),  // original colors  — running, profile keys enabled
    ("TrueReplayerRed",    1.00, 0.18, 0.18, 0.85),  // saturated red    — profile keys paused
    ("TrueReplayerPurple", 0.78, 0.45, 1.05, 0.85),  // saturated purple — clicker mode (#c084fc)
};

foreach (var v in variants)
{
    Console.WriteLine($"\nGenerating {v.Name}.ico ...");

    using var tinted = ApplyTint(src, v.R, v.G, v.B, strength: v.Strength);

    var blobs = new List<byte[]>();
    foreach (var size in sizes)
    {
        using var resized = ResizeBitmap(tinted, size);
        using var ms = new MemoryStream();
        resized.Save(ms, ImageFormat.Png);
        blobs.Add(ms.ToArray());
        Console.WriteLine($"  - {size}x{size} ok");
    }

    string outPath = Path.Combine(outDir, $"{v.Name}.ico");
    SaveIco(outPath, blobs, sizes);
    Console.WriteLine($"Wrote: {outPath} ({new FileInfo(outPath).Length:N0} bytes)");

    // Also dump the 256x256 PNG so the result can be inspected visually without an .ico viewer.
    string previewDir = Path.Combine(outDir, "tools", "IconGen", "preview");
    Directory.CreateDirectory(previewDir);
    File.WriteAllBytes(Path.Combine(previewDir, $"{v.Name}-256.png"), blobs[^1]);
}

Console.WriteLine("\nDone.");

// ─────────────────────────────────────────────────────────────────────────────

static Bitmap ApplyTint(Bitmap src, double tr, double tg, double tb, double strength)
{
    int w = src.Width, h = src.Height;
    var rect = new Rectangle(0, 0, w, h);

    using var srcRgba = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(srcRgba))
        g.DrawImage(src, 0, 0, w, h);

    var result = new Bitmap(w, h, PixelFormat.Format32bppArgb);

    var srcData = srcRgba.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var dstData = result.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);

    int stride = Math.Abs(srcData.Stride);
    int bytes = stride * h;
    var srcBuf = new byte[bytes];
    var dstBuf = new byte[bytes];
    System.Runtime.InteropServices.Marshal.Copy(srcData.Scan0, srcBuf, 0, bytes);

    double cx = (w - 1) / 2.0;
    double cy = (h - 1) / 2.0;
    double rOuter = (w / 2.0) - 0.5;
    double rInner = rOuter - 1.5;

    for (int y = 0; y < h; y++)
    {
        int row = y * stride;
        for (int x = 0; x < w; x++)
        {
            int i = row + x * 4;
            byte b = srcBuf[i], gC = srcBuf[i + 1], r = srcBuf[i + 2], a = srcBuf[i + 3];

            double lum = (0.299 * r + 0.587 * gC + 0.114 * b) / 255.0;

            int trgb_r = (int)Math.Min(255, lum * tr * 255);
            int trgb_g = (int)Math.Min(255, lum * tg * 255);
            int trgb_b = (int)Math.Min(255, lum * tb * 255);

            int or = (int)(r * (1 - strength) + trgb_r * strength);
            int og = (int)(gC * (1 - strength) + trgb_g * strength);
            int ob = (int)(b * (1 - strength) + trgb_b * strength);

            double dx = x - cx;
            double dy = y - cy;
            double dist = Math.Sqrt(dx * dx + dy * dy);
            double mask = dist <= rInner ? 1.0
                        : dist >= rOuter ? 0.0
                        : (rOuter - dist) / (rOuter - rInner);

            int finalA = (int)(a * mask);

            dstBuf[i]     = (byte)ob;
            dstBuf[i + 1] = (byte)og;
            dstBuf[i + 2] = (byte)or;
            dstBuf[i + 3] = (byte)finalA;
        }
    }

    System.Runtime.InteropServices.Marshal.Copy(dstBuf, 0, dstData.Scan0, bytes);
    srcRgba.UnlockBits(srcData);
    result.UnlockBits(dstData);
    return result;
}

static Bitmap ResizeBitmap(Bitmap src, int size)
{
    var resized = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using var g = Graphics.FromImage(resized);
    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
    g.SmoothingMode = SmoothingMode.HighQuality;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    g.CompositingQuality = CompositingQuality.HighQuality;
    g.DrawImage(src, 0, 0, size, size);
    return resized;
}

static void SaveIco(string path, List<byte[]> pngBlobs, int[] sizes)
{
    if (pngBlobs.Count != sizes.Length) throw new InvalidOperationException("blobs/sizes mismatch");
    int count = pngBlobs.Count;

    using var fs = File.Create(path);
    using var bw = new BinaryWriter(fs);

    // ICONDIR
    bw.Write((ushort)0);            // reserved
    bw.Write((ushort)1);            // type: icon
    bw.Write((ushort)count);

    int offset = 6 + 16 * count;
    for (int i = 0; i < count; i++)
    {
        int s = sizes[i];
        byte sb = s >= 256 ? (byte)0 : (byte)s;
        var blob = pngBlobs[i];
        bw.Write(sb);                       // width
        bw.Write(sb);                       // height
        bw.Write((byte)0);                  // palette
        bw.Write((byte)0);                  // reserved
        bw.Write((ushort)1);                // planes
        bw.Write((ushort)32);               // bits per pixel
        bw.Write((uint)blob.Length);        // bytes in res
        bw.Write((uint)offset);             // offset
        offset += blob.Length;
    }

    foreach (var blob in pngBlobs)
        bw.Write(blob);
}
