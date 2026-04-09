Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32WindowLayout {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public const int SW_RESTORE = 9;
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public const UInt32 SWP_SHOWWINDOW = 0x0040;
}
"@

param(
  [int]$Pid,
  [int]$X,
  [int]$Y,
  [int]$Width,
  [int]$Height,
  [string]$Label = ""
)

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ("SCREEN|{0}|{1}" -f $screen.Width, $screen.Height)

$target = $null
$matchedTitle = ""

$callback = [Win32WindowLayout+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [Win32WindowLayout]::IsWindowVisible($hWnd)) {
    return $true
  }

  $procId = 0
  [void][Win32WindowLayout]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  if ($procId -ne $Pid) {
    return $true
  }

  $sb = New-Object System.Text.StringBuilder 512
  [void][Win32WindowLayout]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) {
    return $true
  }

  $script:target = $hWnd
  $script:matchedTitle = $title
  return $false
}

[void][Win32WindowLayout]::EnumWindows($callback, [IntPtr]::Zero)

if ($null -eq $target) {
  Write-Output ("NOT_FOUND|pid={0}|label={1}" -f $Pid, $Label)
  exit 2
}

[void][Win32WindowLayout]::ShowWindow($target, [Win32WindowLayout]::SW_RESTORE)
Start-Sleep -Milliseconds 250
$ok = [Win32WindowLayout]::SetWindowPos($target, [Win32WindowLayout]::HWND_TOP, $X, $Y, $Width, $Height, [Win32WindowLayout]::SWP_SHOWWINDOW)

if ($ok) {
  Write-Output ("MOVED|pid={0}|title={1}|x={2}|y={3}|w={4}|h={5}|label={6}" -f $Pid, $matchedTitle, $X, $Y, $Width, $Height, $Label)
  exit 0
}

Write-Output ("MOVE_FAILED|pid={0}|title={1}|label={2}" -f $Pid, $matchedTitle, $Label)
exit 3
