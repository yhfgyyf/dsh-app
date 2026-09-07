#ifndef AppVersion
  #error AppVersion must be provided
#endif
#ifndef SourceDir
  #error SourceDir must be provided
#endif
#ifndef OutputDir
  #error OutputDir must be provided
#endif

[Setup]
AppId=io.dsh.desktop
AppName=DSH Desktop
AppVersion={#AppVersion}
AppPublisher=yhfgyyf
AppPublisherURL=https://github.com/yhfgyyf/dsh-app
AppSupportURL=https://github.com/yhfgyyf/dsh-app/issues
DefaultDirName={localappdata}\Programs\DSH Desktop
DefaultGroupName=DSH Desktop
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#OutputDir}
OutputBaseFilename=DSH-Desktop-{#AppVersion}-Windows-x64-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\DSH Desktop.exe
CloseApplications=yes
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DSH Desktop"; Filename: "{app}\DSH Desktop.exe"
Name: "{autodesktop}\DSH Desktop"; Filename: "{app}\DSH Desktop.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\DSH Desktop.exe"; Description: "{cm:LaunchProgram,DSH Desktop}"; Flags: nowait postinstall skipifsilent
