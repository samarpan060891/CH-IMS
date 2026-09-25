# Minimal static file server for local testing (no Node/Python needed)
param([int]$Port = 8080, [string]$Root = (Join-Path $PSScriptRoot '..\web'))
$Root = (Resolve-Path $Root).Path
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png'; '.webmanifest'='application/manifest+json'; '.ico'='image/x-icon' }
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root on http://localhost:$Port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }
    $file = Join-Path $Root $path
    $full = [System.IO.Path]::GetFullPath($file)
    if (-not $full.StartsWith($Root) -or -not (Test-Path $full -PathType Leaf)) { $full = Join-Path $Root 'index.html' }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    $ctx.Response.ContentType = $(if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' })
    $ctx.Response.Headers.Add('Cache-Control', 'no-store')
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch { $ctx.Response.StatusCode = 500 }
  finally { $ctx.Response.Close() }
}
