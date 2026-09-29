param(
  [string]$Source = (Join-Path $PSScriptRoot '..\docs\muxentra-logo-concept.svg'),
  [string]$Destination = (Join-Path $PSScriptRoot '..\assets\muxentra-icon.png')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase

[xml]$svg = Get-Content -LiteralPath $Source -Raw
$ns = [System.Xml.XmlNamespaceManager]::new($svg.NameTable)
$ns.AddNamespace('svg', 'http://www.w3.org/2000/svg')
$background = $svg.SelectSingleNode('//svg:linearGradient[@id="background"]', $ns)
$flow = $svg.SelectSingleNode('//svg:linearGradient[@id="flow"]', $ns)
$tile = $svg.SelectSingleNode('//svg:rect', $ns)
$stroke = $svg.SelectSingleNode('//svg:path', $ns)
if (!$background -or !$flow -or !$tile -or !$stroke) { throw 'El SVG no tiene los elementos esperados.' }

function New-GradientBrush([System.Xml.XmlElement]$element, [bool]$absolute) {
  $brush = [System.Windows.Media.LinearGradientBrush]::new()
  if ($absolute) { $brush.MappingMode = [System.Windows.Media.BrushMappingMode]::Absolute }
  $brush.StartPoint = [System.Windows.Point]::new([double]$element.GetAttribute('x1'), [double]$element.GetAttribute('y1'))
  $brush.EndPoint = [System.Windows.Point]::new([double]$element.GetAttribute('x2'), [double]$element.GetAttribute('y2'))
  foreach ($stop in $element.SelectNodes('svg:stop', $ns)) {
    $offset = $stop.GetAttribute('offset')
    if (!$offset) { $offset = '0' }
    $color = [System.Windows.Media.ColorConverter]::ConvertFromString($stop.GetAttribute('stop-color'))
    $brush.GradientStops.Add([System.Windows.Media.GradientStop]::new($color, [double]::Parse($offset, [Globalization.CultureInfo]::InvariantCulture)))
  }
  return $brush
}

$visual = [System.Windows.Media.DrawingVisual]::new()
$context = $visual.RenderOpen()
$size = 256
$radius = [double]$tile.GetAttribute('rx')
$context.DrawRoundedRectangle((New-GradientBrush $background $false), $null, [System.Windows.Rect]::new(0, 0, $size, $size), $radius, $radius)
$pen = [System.Windows.Media.Pen]::new((New-GradientBrush $flow $true), [double]$stroke.GetAttribute('stroke-width'))
$pen.StartLineCap = [System.Windows.Media.PenLineCap]::Round
$pen.EndLineCap = [System.Windows.Media.PenLineCap]::Round
$pen.LineJoin = [System.Windows.Media.PenLineJoin]::Round
$context.DrawGeometry($null, $pen, [System.Windows.Media.Geometry]::Parse($stroke.GetAttribute('d')))
$context.Close()

$bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new($size, $size, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
$bitmap.Render($visual)
$encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
$encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
$stream = [System.IO.File]::Create([System.IO.Path]::GetFullPath($Destination))
try { $encoder.Save($stream) } finally { $stream.Dispose() }
