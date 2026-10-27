# The approval box: the system Yes/No dialog, No as the default button.
# Text and caption come from the environment so nothing has to be quoted into a command line.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AskNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$text = [string]$env:CUA_ASK_TEXT
$title = if ($env:CUA_ASK_TITLE) { [string]$env:CUA_ASK_TITLE } else { 'CUA' }
$result = [System.Windows.Forms.MessageBox]::Show(
  $text,
  $title,
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Warning,
  [System.Windows.Forms.MessageBoxDefaultButton]::Button2
)
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
exit 1
