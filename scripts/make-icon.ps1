Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded square background with the Meldrift purple gradient.
$radius = 230
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 155, 109, 255),
  [System.Drawing.Color]::FromArgb(255, 76, 29, 149),
  45.0
)
$g.FillPath($brush, $path)

# Soft highlight in the top-left corner.
$gloss = New-Object System.Drawing.Drawing2D.GraphicsPath
$gloss.AddEllipse(-260, -320, 900, 700)
$glossBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($gloss)
$glossBrush.CenterColor = [System.Drawing.Color]::FromArgb(46, 255, 255, 255)
$glossBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
$g.FillPath($glossBrush, $gloss)

# White gamepad glyph.
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$body = New-Object System.Drawing.Drawing2D.GraphicsPath
$body.AddBezier(300, 400, 360, 340, 664, 340, 724, 400)
$body.AddBezier(724, 400, 820, 410, 830, 540, 790, 640)
$body.AddBezier(790, 640, 760, 720, 660, 700, 620, 640)
$body.AddLine(620, 640, 404, 640)
$body.AddBezier(404, 640, 364, 700, 264, 720, 234, 640)
$body.AddBezier(234, 640, 194, 540, 204, 410, 300, 400)
$body.CloseFigure()
$g.FillPath($white, $body)

# Cut a heart-shaped notch so the mark reads as "share the game".
$heart = New-Object System.Drawing.Drawing2D.GraphicsPath
$heart.AddBezier(512, 600, 440, 540, 424, 470, 468, 446)
$heart.AddBezier(468, 446, 496, 432, 512, 456, 512, 470)
$heart.AddBezier(512, 470, 512, 456, 528, 432, 556, 446)
$heart.AddBezier(556, 446, 600, 470, 584, 540, 512, 600)
$heart.CloseFigure()
$g.FillPath($brush, $heart)

$bmp.Save((Join-Path (Get-Location) 'app-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output 'icon written'
