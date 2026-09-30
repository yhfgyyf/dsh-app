param([Parameter(Mandatory = $true)][int]$ApplicationId)
$ErrorActionPreference = 'Stop'
# Windows PowerShell provides the desktop UI Automation assemblies. This invokes
# the installed app's real menu; it never terminates the process to fake a quit.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$application = Get-Process -Id $ApplicationId
if ($application.MainWindowHandle -eq 0) { throw 'Application window is not restored' }
$window = [System.Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
$menuType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
$menuBarType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuBar)
$menuBar = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $menuBarType)
if (!$menuBar) { throw 'Application menu bar was not exposed' }
$appName = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'DSH Desktop')
# Electron exposes top-level submenu buttons as popup buttons, not menu items.
$appMenu = $menuBar.FindFirst([System.Windows.Automation.TreeScope]::Children, $appName)
if (!$appMenu) { throw 'DSH Desktop application menu was not exposed' }
# Electron's popup button advertises ExpandCollapse but Expand returns E_FAIL.
# Invoke performs its default Open action, as it does for an ordinary button.
Write-Output 'Invoking the DSH Desktop menu popup button.'
$appMenu.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
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
Write-Output 'Invoking the explicit Quit menu item.'
$quitItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output 'Invoked the installed application Quit menu item.'
