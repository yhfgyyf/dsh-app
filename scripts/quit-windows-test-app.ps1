param([Parameter(Mandatory = $true)][int]$ApplicationId)
$ErrorActionPreference = 'Stop'
# Windows PowerShell provides the desktop UI Automation assemblies. This invokes
# the installed app's real menu; it never terminates the process to fake a quit.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QuitMenuMouse {
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {
    public int dx, dy; public uint mouseData, flags, time; public IntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input {
    public uint type; public MouseInput mouse;
  }
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  public static void Focus(IntPtr window) {
    if (GetForegroundWindow() != window && !SetForegroundWindow(window)) throw new InvalidOperationException("Application could not be brought to the foreground");
  }
  public static void Click(int x, int y) {
    if (!SetCursorPos(x, y)) throw new System.ComponentModel.Win32Exception();
    var inputs = new[] {
      new Input { type = 0, mouse = new MouseInput { flags = 2 } },
      new Input { type = 0, mouse = new MouseInput { flags = 4 } }
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2) throw new System.ComponentModel.Win32Exception();
  }
}
'@
function Click-MenuElement($element) {
  $point = $element.GetClickablePoint()
  [QuitMenuMouse]::Click([int]$point.X, [int]$point.Y)
}
$application = Get-Process -Id $ApplicationId
if ($application.MainWindowHandle -eq 0) { throw 'Application window is not restored' }
[QuitMenuMouse]::Focus($application.MainWindowHandle)
$window = [System.Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
$menuType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
$menuBarType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuBar)
$menuBar = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $menuBarType)
if (!$menuBar) { throw 'Application menu bar was not exposed' }
$appName = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'DSH Desktop')
# Electron exposes top-level submenu buttons as popup buttons, not menu items.
$appMenu = $menuBar.FindFirst([System.Windows.Automation.TreeScope]::Children, $appName)
if (!$appMenu) { throw 'DSH Desktop application menu was not exposed' }
# Electron's popup advertises ExpandCollapse but Expand returns E_FAIL, and
# Invoke is unsupported. Click its freshly resolved accessible point instead.
Write-Output 'Clicking the DSH Desktop menu popup button.'
Click-MenuElement $appMenu
# Keep this helper ASCII so Windows PowerShell 5.1 reads it consistently.
$quitLabel = [string][char]0x9000 + [char]0x51fa + ' DSH Desktop'
$quitName = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $quitLabel)
$processCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ApplicationId)
$quitCondition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@($menuType, $quitName, $processCondition))
$deadline = (Get-Date).AddSeconds(10)
do {
  $quitItem = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $quitCondition)
  if (!$quitItem) { Start-Sleep -Milliseconds 100 }
} until ($quitItem -or (Get-Date) -gt $deadline)
if (!$quitItem) { throw 'Application quit menu item was not exposed' }
Write-Output 'Clicking the explicit Quit menu item.'
Click-MenuElement $quitItem
Write-Output 'Invoked the installed application Quit menu item.'
