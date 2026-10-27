# Coopanion CUA engine: one PowerShell process per call, JSON in / JSON out.
#
# Ops: info | screenshot | windows | click | move | drag | scroll | type | key | focus
#
# Why PowerShell: a Cortico World extension runs in the Core Node process and installs through pnpm;
# the fewest moving parts that still does real screen capture is the Windows PowerShell that ships
# with the OS. The cost is ~250-500 ms per call, which is fine for a chat bot (a tool call takes tens
# of seconds anyway). Swap in koffi + GDI later if that latency ever matters - the desktop-pet world
# does exactly that, at the price of a native dependency and a build step.
#
# DPI: the process is made per-monitor-DPI-aware *before* any screen call, so screenshot pixels are
# physical pixels and the coordinates we hand back can be used verbatim for clicks.
param(
  [Parameter(Mandatory = $true)][string]$Op,
  [string]$Json = '{}'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# UTF-8 on stdout: the caller (Node) reads stdout as UTF-8, but Windows PowerShell defaults the
# console code page to the system one (GBK here), which would turn every Chinese window title into
# question marks on the way out.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CuaNative {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr param);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr param);
}
'@

# Per-monitor DPI aware v2 (-4); older builds fall back to system DPI aware.
try { [void][CuaNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][CuaNative]::SetProcessDPIAware() } catch {} }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$args_ = @{}
if ($Json -and $Json.Trim()) {
  $parsed = $Json | ConvertFrom-Json
  foreach ($p in $parsed.PSObject.Properties) { $args_[$p.Name] = $p.Value }
}

function Get-Screens {
  $list = @()
  for ($i = 0; $i -lt [System.Windows.Forms.Screen]::AllScreens.Count; $i++) {
    $s = [System.Windows.Forms.Screen]::AllScreens[$i]
    $list += [ordered]@{
      index   = $i + 1
      primary = ($s.Primary -eq $true)
      x       = $s.Bounds.X
      y       = $s.Bounds.Y
      width   = $s.Bounds.Width
      height  = $s.Bounds.Height
    }
  }
  return $list
}

function Get-ForegroundTitle {
  $h = [CuaNative]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][CuaNative]::GetWindowTextW($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Get-Cursor {
  $p = [System.Windows.Forms.Cursor]::Position
  return [ordered]@{ x = $p.X; y = $p.Y }
}

function Write-Json($obj) {
  $obj | ConvertTo-Json -Depth 8 -Compress
}

$DEFAULT_MAX_W = 1280
$DEFAULT_MAX_H = 800
$DEFAULT_QUALITY = 75

switch ($Op) {
  'info' {
    Write-Json ([ordered]@{
        screens    = @(Get-Screens)
        cursor     = Get-Cursor
        foreground = Get-ForegroundTitle
      })
  }

  'windows' {
    $script:out = @()
    $cb = {
      param($hWnd, $lParam)
      if (-not [CuaNative]::IsWindowVisible($hWnd)) { return $true }
      $sb = New-Object System.Text.StringBuilder 512
      [void][CuaNative]::GetWindowTextW($hWnd, $sb, $sb.Capacity)
      $title = $sb.ToString()
      if (-not $title) { return $true }
      $pid_ = 0
      [void][CuaNative]::GetWindowThreadProcessId($hWnd, [ref]$pid_)
      $r = New-Object CuaNative+RECT
      [void][CuaNative]::GetWindowRect($hWnd, [ref]$r)
      $script:out += [ordered]@{
        handle     = ('0x{0:x}' -f $hWnd.ToInt64())
        title      = $title
        pid        = [int]$pid_
        foreground = ($hWnd -eq [CuaNative]::GetForegroundWindow())
        minimized  = [CuaNative]::IsIconic($hWnd)
        rect       = [ordered]@{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
      }
      return $true
    }
    [void][CuaNative]::EnumWindows($cb, [IntPtr]::Zero)
    Write-Json @($script:out | Select-Object -First 80)
  }

  'focus' {
    $want = [string]$args_['window']
    $target = [IntPtr]::Zero
    if ($want -match '^0x[0-9a-fA-F]+$') {
      $target = [IntPtr]([Convert]::ToInt64($want.Substring(2), 16))
    }
    else {
      $script:found = [IntPtr]::Zero
      $cb = {
        param($hWnd, $lParam)
        if (-not [CuaNative]::IsWindowVisible($hWnd)) { return $true }
        $sb = New-Object System.Text.StringBuilder 512
        [void][CuaNative]::GetWindowTextW($hWnd, $sb, $sb.Capacity)
        if ($sb.ToString() -like "*$want*") { $script:found = $hWnd; return $false }
        return $true
      }
      [void][CuaNative]::EnumWindows($cb, [IntPtr]::Zero)
      $target = $script:found
    }
    if ($target -eq [IntPtr]::Zero) { Write-Json @{ ok = $false; error = "window not found: $want" }; break }
    if ([CuaNative]::IsIconic($target)) { [void][CuaNative]::ShowWindow($target, 9) }
    $ok = [CuaNative]::SetForegroundWindow($target)
    Write-Json @{ ok = [bool]$ok; foreground = (Get-ForegroundTitle) }
  }


  'screenshot' {
    $shots = Get-Screens
    $index = if ($args_['display']) { [int]$args_['display'] } else { 1 }
    $s = $shots | Where-Object { $_.index -eq $index } | Select-Object -First 1
    if (-not $s) { Write-Json @{ ok = $false; error = "no display $index" }; break }
    $maxW = if ($args_['maxWidth']) { [int]$args_['maxWidth'] } else { $DEFAULT_MAX_W }
    $maxH = if ($args_['maxHeight']) { [int]$args_['maxHeight'] } else { $DEFAULT_MAX_H }
    $quality = if ($args_['quality']) { [int]$args_['quality'] } else { $DEFAULT_QUALITY }

    $full = New-Object System.Drawing.Bitmap $s.width, $s.height
    $gFull = [System.Drawing.Graphics]::FromImage($full)
    try { $gFull.CopyFromScreen($s.x, $s.y, 0, 0, $full.Size) } finally { $gFull.Dispose() }

    $scale = [Math]::Min(1.0, [Math]::Min($maxW / $s.width, $maxH / $s.height))
    $w = [int][Math]::Round($s.width * $scale)
    $h = [int][Math]::Round($s.height * $scale)
    $scaled = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($scaled)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    try { $g.DrawImage($full, 0, 0, $w, $h) } finally { $g.Dispose(); $full.Dispose() }

    # Draw the pointer where it is, so "look at the tip of the mouse" works.
    $cur = Get-Cursor
    $cx = ($cur.x - $s.x) * $scale
    $cy = ($cur.y - $s.y) * $scale
    if ($cx -ge 0 -and $cy -ge 0 -and $cx -lt $w -and $cy -lt $h) {
      $g2 = [System.Drawing.Graphics]::FromImage($scaled)
      $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
      $black = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 1
      try {
        $pts = @(
          (New-Object System.Drawing.PointF([float]$cx, [float]$cy)),
          (New-Object System.Drawing.PointF([float]$cx, [float]($cy + 16))),
          (New-Object System.Drawing.PointF([float]($cx + 5), [float]($cy + 12))),
          (New-Object System.Drawing.PointF([float]($cx + 11), [float]($cy + 12)))
        )
        $g2.FillPolygon($white, [System.Drawing.PointF[]]$pts)
        $g2.DrawPolygon($black, [System.Drawing.PointF[]]$pts)
      } finally { $white.Dispose(); $black.Dispose(); $g2.Dispose() }
    }

    $ms = New-Object System.IO.MemoryStream
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $enc = New-Object System.Drawing.Imaging.EncoderParameters 1
    $enc.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([int]$quality)
    try { $scaled.Save($ms, $codec, $enc) } finally { $scaled.Dispose() }
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose()

    Write-Json ([ordered]@{
        ok         = $true
        display    = $s.index
        width      = $w
        height     = $h
        scale      = [Math]::Round($scale, 4)
        screens    = @($shots)
        cursor     = $cur
        foreground = Get-ForegroundTitle
        mime       = 'image/jpeg'
        base64     = $b64
      })
  }

  'click' {
    $x = [int]$args_['x']; $y = [int]$args_['y']
    $button = if ($args_['button']) { [string]$args_['button'] } else { 'left' }
    $clicks = if ($args_['clicks']) { [int]$args_['clicks'] } else { 1 }
    [void][CuaNative]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 40
    $down = 0x0002; $up = 0x0004
    if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
    elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
    for ($i = 0; $i -lt $clicks; $i++) {
      [CuaNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [CuaNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 30
    }
    Write-Json @{ ok = $true; x = $x; y = $y; button = $button; clicks = $clicks }
  }

  'move' {
    $x = [int]$args_['x']; $y = [int]$args_['y']
    [void][CuaNative]::SetCursorPos($x, $y)
    Write-Json @{ ok = $true; x = $x; y = $y }
  }

  'drag' {
    $from = $args_['from']; $to = $args_['to']
    [void][CuaNative]::SetCursorPos([int]$from[0], [int]$from[1])
    Start-Sleep -Milliseconds 60
    [CuaNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [void][CuaNative]::SetCursorPos([int]$to[0], [int]$to[1])
    Start-Sleep -Milliseconds 80
    [CuaNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Write-Json @{ ok = $true }
  }

  'scroll' {
    $x = [int]$args_['x']; $y = [int]$args_['y']
    $down = if ($null -ne $args_['down']) { [int]$args_['down'] } else { 0 }
    $right = if ($null -ne $args_['right']) { [int]$args_['right'] } else { 0 }
    [void][CuaNative]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 40
    if ($down -ne 0) { [CuaNative]::mouse_event(0x0800, 0, 0, ([uint32]([Math]::Abs($down) * 120)), [UIntPtr]::Zero) }
    if ($right -ne 0) { [CuaNative]::mouse_event(0x01000, 0, 0, ([uint32]([Math]::Abs($right) * 120)), [UIntPtr]::Zero) }
    Write-Json @{ ok = $true; down = $down; right = $right }
  }

  'type' {
    $NL = [char]10
    $text = [string]$args_['text']
    foreach ($ch in $text.ToCharArray()) {
      if ($ch -eq $NL) {
        [CuaNative]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
        [CuaNative]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
        continue
      }
      $code = [int][char]$ch
      [CuaNative]::keybd_event(0, [byte]($code -band 0xFF), 4, [UIntPtr]::Zero)
      [CuaNative]::keybd_event(0, [byte]($code -band 0xFF), 6, [UIntPtr]::Zero)
      if ($code -gt 0xFF) {
        [CuaNative]::keybd_event(0, [byte](($code -shr 8) -band 0xFF), 4, [UIntPtr]::Zero)
        [CuaNative]::keybd_event(0, [byte](($code -shr 8) -band 0xFF), 6, [UIntPtr]::Zero)
      }
      Start-Sleep -Milliseconds 8
    }
    Write-Json @{ ok = $true; chars = $text.Length }
  }

  'key' {
    $keys = [string]$args_['keys']
    $script:keymap = @{
      'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B
      'enter' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20
      'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D
      'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
      'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
      'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
      'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
    }
    $toVk = {
      param([string]$name)
      $n = $name.Trim().ToLowerInvariant()
      if ($script:keymap.ContainsKey($n)) { return [byte]$script:keymap[$n] }
      if ($n.Length -eq 1) {
        $code = [int][char]$n.ToUpperInvariant()
        if (($code -ge 0x30 -and $code -le 0x5A)) { return [byte]$code }
      }
      throw "unknown key: $name"
    }
    foreach ($chord in ($keys -split '\s+')) {
      if (-not $chord) { continue }
      $codes = @(($chord -split '\+') | ForEach-Object { & $toVk $_ })
      foreach ($c in $codes) { [CuaNative]::keybd_event($c, 0, 0, [UIntPtr]::Zero) }
      [array]::Reverse($codes)
      foreach ($c in $codes) { [CuaNative]::keybd_event($c, 0, 2, [UIntPtr]::Zero) }
      Start-Sleep -Milliseconds 30
    }
    Write-Json @{ ok = $true; keys = $keys }
  }

  default {
    Write-Json @{ ok = $false; error = "unknown op: $Op" }
  }
}
