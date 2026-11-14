param([string]$PreviewDirectory)
$ErrorActionPreference = 'Stop'
# Run with Windows PowerShell -STA. WPF is only used to render vector assets to files.
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase
$assets = Join-Path $PSScriptRoot '../src/AgentLink.App/Assets'
$dictionary = [Windows.Markup.XamlReader]::Parse([IO.File]::ReadAllText((Join-Path $assets 'Brand.xaml')))
$drawing = $dictionary['BrandMark']
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$frames = @($sizes | ForEach-Object {
    $size = $_
    $visual = New-Object Windows.Media.DrawingVisual
    $context = $visual.RenderOpen()
    $context.DrawImage($drawing, (New-Object Windows.Rect(0, 0, $size, $size)))
    $context.Close()
    $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap($size, $size, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = New-Object IO.MemoryStream
    try { $encoder.Save($stream); ,$stream.ToArray() } finally { $stream.Dispose() }
})
$file = [IO.File]::Create((Join-Path $assets 'AgentLink.ico'))
$writer = New-Object IO.BinaryWriter($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    for ($i = 0; $i -lt $frames.Count; $i++) {
        $edge = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$edge); $writer.Write([byte]$edge)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
} finally { $writer.Dispose() }
if ($PreviewDirectory) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($PreviewDirectory)) | Out-Null
    for ($i = 0; $i -lt $frames.Count; $i++) {
        [IO.File]::WriteAllBytes((Join-Path $PreviewDirectory "icon-$($sizes[$i]).png"), $frames[$i])
    }
}
Write-Output 'Exported AgentLink.ico (16, 20, 24, 32, 40, 48, 64, 128, 256 px).'
