# The approval box: a topmost Yes/No window, No as the default button.
# Text and caption come from the environment so nothing has to be quoted into a command line.
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AskNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

  $text = [string]$env:CUA_ASK_TEXT
  $title = if ($env:CUA_ASK_TITLE) { [string]$env:CUA_ASK_TITLE } else { 'CUA' }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = $title
  $form.TopMost = $true
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.ShowInTaskbar = $true
  $form.ClientSize = New-Object System.Drawing.Size(560, 240)

  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.UseMnemonic = $false
  $label.AutoSize = $false
  $label.Location = New-Object System.Drawing.Point(16, 16)
  $label.Size = New-Object System.Drawing.Size(528, 160)
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $form.Controls.Add($label)

  $yes = New-Object System.Windows.Forms.Button
  $yes.Text = 'Yes'
  $yes.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $yes.Location = New-Object System.Drawing.Point(360, 190)
  $yes.Size = New-Object System.Drawing.Size(84, 32)
  $form.Controls.Add($yes)

  $no = New-Object System.Windows.Forms.Button
  $no.Text = 'No'
  $no.DialogResult = [System.Windows.Forms.DialogResult]::No
  $no.Location = New-Object System.Drawing.Point(456, 190)
  $no.Size = New-Object System.Drawing.Size(84, 32)
  $form.Controls.Add($no)

  # No is the default: Enter or Esc does nothing, and closing the window is a refusal.
  $form.AcceptButton = $no
  $form.CancelButton = $no
  $form.Add_Shown({
    $form.Activate()
    $form.BringToFront()
    [void][AskNative]::SetForegroundWindow($form.Handle)
  })

  $result = $form.ShowDialog()
  $form.Dispose()
  if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
  exit 1
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
