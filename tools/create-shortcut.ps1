# Creates a "Citi Homes IMS" desktop icon that opens the live app in its own window (Edge app mode).
# Run on any staff PC:  powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
param([string]$Url = 'https://ch-ims-production.up.railway.app')

Add-Type -AssemblyName System.Drawing
$dir = Join-Path $env:LOCALAPPDATA 'CitiHomesIMS'
New-Item -ItemType Directory -Force $dir | Out-Null
$ico = Join-Path $dir 'citihomes.ico'

# --- draw the logo (brown rounded square with "CH") at a given pixel size ---
function New-Logo([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [Math]::Max(4, [int]($size * 0.19))
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $r, $r, 180, 90); $p.AddArc($size - $r - 1, 0, $r, $r, 270, 90)
  $p.AddArc($size - $r - 1, $size - $r - 1, $r, $r, 0, 90); $p.AddArc(0, $size - $r - 1, $r, $r, 90, 90); $p.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(138, 90, 43))), $p)
  $font = New-Object System.Drawing.Font 'Segoe UI', ([single]($size * 0.42)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('CH', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, ([single]($size * 0.03)), $size, $size), $fmt)
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

# --- write a multi-size .ico: 16/32/48 as DIB, 256 as PNG ---
$images = @()
foreach ($s in 16, 32, 48) { $b = New-Logo $s; $images += ,@($s, (Get-DibBytes $b)); $b.Dispose() }
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
