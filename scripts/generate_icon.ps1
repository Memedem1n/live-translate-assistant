param(
  [string]$OutputPath = "build/icon.ico"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeIconMethods {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
"@

$outputDir = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(255, 10, 19, 30))

$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)),
  [System.Drawing.Color]::FromArgb(255, 52, 210, 199),
  [System.Drawing.Color]::FromArgb(255, 25, 96, 140)
)

$circleRect = New-Object System.Drawing.Rectangle(20, 20, 216, 216)
$graphics.FillEllipse($gradient, $circleRect)

$innerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 6, 19, 30))
$graphics.FillEllipse($innerBrush, 42, 42, 172, 172)

$font = New-Object System.Drawing.Font("Segoe UI", 88, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 233, 245, 255))
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString("LT", $font, $textBrush, (New-Object System.Drawing.RectangleF(0, 0, $size, $size)), $format)

$hIcon = $bitmap.GetHicon()
try {
  $icon = [System.Drawing.Icon]::FromHandle($hIcon)
  $fileStream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create)
  try {
    $icon.Save($fileStream)
  } finally {
    $fileStream.Dispose()
    $icon.Dispose()
  }
} finally {
  [NativeIconMethods]::DestroyIcon($hIcon) | Out-Null
  $format.Dispose()
  $textBrush.Dispose()
  $font.Dispose()
  $innerBrush.Dispose()
  $gradient.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output "Icon generated at $OutputPath"
