import { dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LocalOpenRequest } from '../shared/local-open.ts';
import { absolutePath, localTargetPath } from './local-path.ts';

const run = promisify(execFile);

// SHOpenWithDialog uses Windows' per-file application chooser. Paths are passed
// as environment data, never interpolated into PowerShell or C# source.
export const WINDOWS_OPEN_WITH = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct OpenAsInfo {
  [MarshalAs(UnmanagedType.LPWStr)] public string File;
  [MarshalAs(UnmanagedType.LPWStr)] public string Class;
  public uint Flags;
}
public static class OpenWith {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  public static extern int SHOpenWithDialog(IntPtr parent, ref OpenAsInfo info);
}
'@
$info = New-Object OpenAsInfo
$info.File = $env:DSH_DESKTOP_OPEN_TARGET
$info.Flags = 4
$result = [OpenWith]::SHOpenWithDialog([IntPtr]::Zero, [ref]$info)
if ($result -lt 0 -and $result -ne -2147023673) { throw ('Open With failed: ' + $result) }
`;

export async function openLocal(window: BrowserWindow, request: LocalOpenRequest): Promise<void> {
  if (!request || !['default', 'choose-app', 'reveal', 'pick-file', 'pick-directory'].includes(request.action)) throw new Error('本地打开参数无效。');
  let path: string;
  if (request.action === 'pick-file' || request.action === 'pick-directory') {
    const directory = request.action === 'pick-directory';
    const result = await dialog.showOpenDialog(window, {
      title: directory ? '选择要打开的文件夹' : '选择要打开的文件', buttonLabel: '打开',
      ...(absolutePath(request.cwd) ? { defaultPath: request.cwd } : {}),
      properties: [directory ? 'openDirectory' : 'openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return;
    path = localTargetPath({ path: result.filePaths[0] });
  } else path = localTargetPath(request.target);
  const info = await stat(path).catch(() => { throw new Error('文件或文件夹不存在，可能已移动或删除。'); });
  if (!info.isFile() && !info.isDirectory()) throw new Error('请选择普通文件或文件夹。');
  if (request.action === 'reveal') { shell.showItemInFolder(path); return; }
  if (request.action === 'choose-app') {
    if (process.platform === 'win32') {
      if (!info.isFile()) throw new Error('文件夹请使用“在本地打开”。');
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await run(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_OPEN_WITH, 'utf16le').toString('base64')], {
        windowsHide: true, env: { ...process.env, DSH_DESKTOP_OPEN_TARGET: path },
      }).catch(() => { throw new Error('无法打开系统的“打开方式”面板。请在文件夹中显示该文件，再右键选择打开方式。'); });
      return;
    }
    if (process.platform === 'darwin') {
      const result = await dialog.showOpenDialog(window, { title: '选择打开此文件的应用', defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: '应用程序', extensions: ['app'] }] });
      if (!result.canceled && result.filePaths[0]) await run('/usr/bin/open', ['-a', result.filePaths[0], path]).catch(() => { throw new Error('无法使用所选应用打开此文件，请选择其他应用。'); });
      return;
    }
    throw new Error('当前系统不支持选择打开方式。');
  }
  const error = await shell.openPath(path);
  if (error) throw new Error(`无法打开此文件，请通过“选择其他应用”指定打开方式。${error}`);
}
