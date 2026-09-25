# Creates a "Citi Homes IMS" desktop icon that opens the live app in its own window (Edge app mode).
# Run on any staff PC:  powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
param([string]$Url = 'https://ch-ims-production.up.railway.app')

Add-Type -AssemblyName System.Drawing
$dir = Join-Path $env:LOCALAPPDATA 'CitiHomesIMS'
New-Item -ItemType Directory -Force $dir | Out-Null
# a fresh file name each time, so Windows never shows a cached older icon
Get-ChildItem $dir -Filter 'citihomes*.ico' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
$ico = Join-Path $dir ('citihomes-ims-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.ico')

# --- Citi Homes IMS logo (approved option B), drawn in a 200 x 200 design space ---
# CH monogram geometry is in a 680 x 340 box: thin open C + H whose crossbar starts inside the C.
function Draw-Monogram($g, [single]$x, [single]$y, [single]$w, [single]$strokeBoost) {
  $s = $w / 680.0
  $st = $g.Save()
  $g.TranslateTransform($x, $y); $g.ScaleTransform($s, $s)
  $white = [System.Drawing.Color]::White
  $pen = New-Object System.Drawing.Pen $white, ([single](13 * $strokeBoost))
  $g.DrawArc($pen, 5, 5, 330, 330, 30, 300)                                   # C: centre (170,170) r 165, open on the right
  $b = New-Object System.Drawing.SolidBrush $white
  $bh = 12 * $strokeBoost
  $g.FillRectangle($b, [single]305, [single](170 - $bh / 2), [single]365, [single]$bh)   # crossbar from inside the C
  foreach ($cx in 445, 635) {                                                 # slightly flared stems
    $hw = 11 * $strokeBoost; $mw = 8 * $strokeBoost
    $pts = @((New-Object System.Drawing.PointF ($cx - $hw), 5), (New-Object System.Drawing.PointF ($cx + $hw), 5),
             (New-Object System.Drawing.PointF ($cx + $mw), 170), (New-Object System.Drawing.PointF ($cx + $hw), 335),
             (New-Object System.Drawing.PointF ($cx - $hw), 335), (New-Object System.Drawing.PointF ($cx - $mw), 170))
    $g.FillPolygon($b, [System.Drawing.PointF[]]$pts)
  }
  $g.Restore($st)
}

function New-Logo([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 200.0
  $g.ScaleTransform($k, $k)
  $black = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(17, 17, 17))
  $brown = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(138, 90, 43))
  $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $serif = if ((New-Object System.Drawing.Text.InstalledFontCollection).Families.Name -contains 'Georgia') { 'Georgia' } else { 'Times New Roman' }

  if ($size -le 24) {
    # tiny (taskbar / small icons): circle + CH only, heavier strokes so it stays visible
    $g.FillEllipse($black, 4, 4, 192, 192)
    Draw-Monogram $g 24 62 152 ([single]($(if ($size -le 16) { 2.4 } else { 1.9 })))
  } elseif ($size -le 32) {
    # small: circle + CH + IMS badge
    $g.FillEllipse($black, 4, 0, 192, 192)
    Draw-Monogram $g 28 38 144 1.4
    $badge = New-Object System.Drawing.Drawing2D.GraphicsPath
    $badge.AddArc(52, 150, 44, 44, 90, 180); $badge.AddArc(104, 150, 44, 44, 270, 180); $badge.CloseFigure()
    $g.FillPath($brown, $badge); $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 4), $badge)
    $f = New-Object System.Drawing.Font $serif, 26, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('IMS', $f, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 52, 150, 96, 44), $fmt)
  } else {
    # full option B logo (desktop sizes 48 and up); strokes a little heavier at 48-64 px
    $boost = if ($size -le 64) { 1.35 } else { 1 }
    $g.FillEllipse($black, 12, 6, 176, 176)
    Draw-Monogram $g 44 46 112 $boost
    $f1 = New-Object System.Drawing.Font $serif, ([single]$(if ($size -le 64) { 16 } else { 14 })), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString($(if ($size -le 64) { 'CITI HOMES' } else { 'C I T I   H O M E S' }), $f1, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 110, 200, 22), $fmt)
    $badge = New-Object System.Drawing.Drawing2D.GraphicsPath
    $badge.AddArc(66, 164, 26, 26, 90, 180); $badge.AddArc(108, 164, 26, 26, 270, 180); $badge.CloseFigure()
    $g.FillPath($brown, $badge); $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 2), $badge)
    $f2 = New-Object System.Drawing.Font $serif, 13, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('I M S', $f2, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 66, 164, 68, 26), $fmt)
  }
  $g.Dispose()
  return $bmp
}

# --- icon image as a classic 32-bit DIB (BITMAPINFOHEADER + BGRA rows bottom-up + AND mask) ---
function Get-DibBytes([System.Drawing.Bitmap]$bmp) {
  $n = $bmp.Width
  $ms = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter $ms
  $w.Write([UInt32]40); $w.Write([Int32]$n); $w.Write([Int32]($n * 2)); $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]0); $w.Write([UInt32]0); $w.Write([Int32]0); $w.Write([Int32]0); $w.Write([UInt32]0); $w.Write([UInt32]0)
  for ($y = $n - 1; $y -ge 0; $y--) { for ($x = 0; $x -lt $n; $x++) { $c = $bmp.GetPixel($x, $y); $w.Write([byte]$c.B); $w.Write([byte]$c.G); $w.Write([byte]$c.R); $w.Write([byte]$c.A) } }
  $maskRow = [int]([Math]::Ceiling($n / 32.0) * 4)
  $w.Write((New-Object byte[] ($maskRow * $n)))      # all-zero AND mask: alpha channel decides transparency
  $w.Flush(); return $ms.ToArray()
}

# --- write a multi-size .ico: 16-128 as DIB, 256 as PNG (covers 100%-200% display scaling) ---
$images = @()
foreach ($s in 16, 24, 32, 48, 64, 96, 128) { $b = New-Logo $s; $images += ,@($s, (Get-DibBytes $b)); $b.Dispose() }
$b = New-Logo 256; $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
$images += ,@(256, $ms.ToArray())
$fs = [System.IO.File]::Create($ico); $bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($im in $images) {
  $dim = if ($im[0] -ge 256) { 0 } else { $im[0] }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$im[1].Length); $bw.Write([UInt32]$offset)
  $offset += $im[1].Length
}
foreach ($im in $images) { $bw.Write([byte[]]$im[1]) }
$bw.Close()

# --- browser: Edge (preferred), else Chrome ---
$browser = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
             "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
           Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Neither Microsoft Edge nor Google Chrome was found.' }

# --- shortcut on the desktop ---
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Citi Homes IMS.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $browser
$s.Arguments = "--app=$Url"
$s.IconLocation = "$ico,0"
$s.Description = 'Citi Homes Inventory Management'
$s.WorkingDirectory = Split-Path $browser
$s.Save()
Write-Host "Created: $lnk"
