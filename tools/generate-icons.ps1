# Generates TrueReplayer.ico (green), TrueReplayerRed.ico (red), TrueReplayerPurple.ico (purple)
# from a high-resolution source PNG. Each .ico contains multiple resolutions (16, 24, 32, 48, 64, 128, 256)
# encoded as PNG (Vista+ format) for better quality at all sizes.
#
# Tinting strategy: blend(original, grayscale*tintColor, 0.55) — keeps original detail visible while
# washing the image in the requested hue. A circular alpha mask is also applied so the icon reads as a
# circular badge instead of a square crop, matching the existing tile asset shape.

param(
  [string]$Source = "Assets/Square310x310Logo.png",
  [string]$OutDir = "."
)

Add-Type -AssemblyName System.Drawing

$sourceFull = Resolve-Path $Source
Write-Host "Source: $sourceFull"

# Load source bitmap
$src = [System.Drawing.Image]::FromFile($sourceFull)
Write-Host "Source size: $($src.Width)x$($src.Height)"

# Resolutions to embed in each .ico (Windows ignores duplicates and picks best fit per context)
$sizes = @(16, 24, 32, 48, 64, 128, 256)

# Three variants: name + tint RGB
$variants = @(
  @{ Name = "TrueReplayer";       R = 0.40; G = 1.00; B = 0.45 }   # green
  @{ Name = "TrueReplayerRed";    R = 1.00; G = 0.30; B = 0.30 }   # red
  @{ Name = "TrueReplayerPurple"; R = 0.75; G = 0.52; B = 0.99 }   # purple (#c084fc)
)

function Apply-Tint {
  param(
    [System.Drawing.Bitmap]$Source,
    [double]$Tr, [double]$Tg, [double]$Tb,
    [double]$Strength = 0.55
  )

  $w = $Source.Width
  $h = $Source.Height
  $out = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

  # Lock both bitmaps
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $srcData = $Source.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                              [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $dstData = $out.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
                           [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

  $stride = [Math]::Abs($srcData.Stride)
  $bytes = $stride * $h
  $buf = New-Object byte[] $bytes
  $dst = New-Object byte[] $bytes
  [System.Runtime.InteropServices.Marshal]::Copy($srcData.Scan0, $buf, 0, $bytes)

  # Circular alpha mask params
  $cx = ($w - 1) / 2.0
  $cy = ($h - 1) / 2.0
  $rOuter = ($w / 2.0) - 0.5     # full radius
  $rInner = $rOuter - 1.5        # 1.5px feather edge

  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $i = ($y * $stride) + ($x * 4)
      $b = [int]$buf[$i]
      $g = [int]$buf[$i + 1]
      $r = [int]$buf[$i + 2]
      $a = [int]$buf[$i + 3]

      # Luminance (Rec. 601)
      $lum = (0.299 * $r + 0.587 * $g + 0.114 * $b) / 255.0

      # Tinted pixel: grayscale * tint color
      $tr = [int]([Math]::Min(255, $lum * $Tr * 255))
      $tg = [int]([Math]::Min(255, $lum * $Tg * 255))
      $tb = [int]([Math]::Min(255, $lum * $Tb * 255))

      # Blend original with tinted version
      $or = [int]($r * (1 - $Strength) + $tr * $Strength)
      $og = [int]($g * (1 - $Strength) + $tg * $Strength)
      $ob = [int]($b * (1 - $Strength) + $tb * $Strength)

      # Circular alpha mask (anti-aliased edge)
      $dx = $x - $cx
      $dy = $y - $cy
      $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)
      $mask = if ($dist -le $rInner) { 1.0 }
              elseif ($dist -ge $rOuter) { 0.0 }
              else { ($rOuter - $dist) / ($rOuter - $rInner) }

      $finalA = [int]($a * $mask)

      $dst[$i]     = [byte]$ob
      $dst[$i + 1] = [byte]$og
      $dst[$i + 2] = [byte]$or
      $dst[$i + 3] = [byte]$finalA
    }
  }

  [System.Runtime.InteropServices.Marshal]::Copy($dst, 0, $dstData.Scan0, $bytes)
  $Source.UnlockBits($srcData)
  $out.UnlockBits($dstData)
  return $out
}

function Resize-Bitmap {
  param([System.Drawing.Bitmap]$Source, [int]$Size)

  $resized = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($resized)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($Source, 0, 0, $Size, $Size)
  $g.Dispose()
  return $resized
}

function Save-Ico {
  param(
    [string]$Path,
    [System.Collections.Generic.List[byte[]]]$PngBlobs,
    [int[]]$Sizes
  )

  if ($PngBlobs.Count -ne $Sizes.Length) { throw "PNG count != sizes count" }
  $count = $PngBlobs.Count

  $stream = [System.IO.File]::Create($Path)
  try {
    $writer = New-Object System.IO.BinaryWriter $stream

    # ICONDIR header (6 bytes)
    $writer.Write([uint16]0)        # reserved
    $writer.Write([uint16]1)        # type: 1 = icon
    $writer.Write([uint16]$count)   # count

    # ICONDIRENTRY (16 bytes each)
    $offset = 6 + (16 * $count)
    for ($i = 0; $i -lt $count; $i++) {
      $size = $Sizes[$i]
      $sizeByte = if ($size -ge 256) { 0 } else { $size }   # 0 means 256
      $blob = $PngBlobs[$i]
      $writer.Write([byte]$sizeByte)         # width
      $writer.Write([byte]$sizeByte)         # height
      $writer.Write([byte]0)                  # color palette
      $writer.Write([byte]0)                  # reserved
      $writer.Write([uint16]1)                # color planes
      $writer.Write([uint16]32)               # bits per pixel
      $writer.Write([uint32]$blob.Length)     # bytes in res
      $writer.Write([uint32]$offset)          # offset
      $offset += $blob.Length
    }

    # PNG image data
    foreach ($blob in $PngBlobs) {
      $writer.Write($blob)
    }

    $writer.Flush()
  }
  finally {
    $stream.Close()
  }
}

# Pre-generate the high-res tinted master for each variant, then resize for each target size.
# (Tinting at high res then downsampling produces much cleaner small icons than tinting after resize.)
foreach ($v in $variants) {
  Write-Host ""
  Write-Host "Generating $($v.Name).ico ..."

  $masterSrc = New-Object System.Drawing.Bitmap $src
  $tinted = Apply-Tint -Source $masterSrc -Tr $v.R -Tg $v.G -Tb $v.B
  $masterSrc.Dispose()

  $blobs = New-Object 'System.Collections.Generic.List[byte[]]'
  foreach ($size in $sizes) {
    $resized = Resize-Bitmap -Source $tinted -Size $size
    $ms = New-Object System.IO.MemoryStream
    $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $blobs.Add($ms.ToArray())
    $resized.Dispose()
    $ms.Dispose()
    Write-Host "  - $($size)x$($size) ok"
  }

  $tinted.Dispose()

  $outPath = Join-Path $OutDir "$($v.Name).ico"
  Save-Ico -Path $outPath -PngBlobs $blobs -Sizes $sizes
  Write-Host "Wrote: $outPath ($((Get-Item $outPath).Length) bytes)"
}

$src.Dispose()
Write-Host ""
Write-Host "Done."
