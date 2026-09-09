import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export async function holdWindowsDll(dll: string, directory: string) {
  const script = join(directory, 'hold-dll.ps1');
  await writeFile(script, `Add-Type -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadLibrary(string path);' -Name Native -Namespace Fixture\n$module = [Fixture.Native]::LoadLibrary('${dll.replaceAll("'", "''")}')\nif ($module -eq [IntPtr]::Zero) { exit 1 }\n[Console]::WriteLine('ready')\n[Console]::ReadLine() | Out-Null\n`);
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DLL holder did not start')), 15000);
      holder.once('error', error => { clearTimeout(timer); reject(error); });
      holder.once('exit', code => { clearTimeout(timer); reject(new Error(`DLL holder exited: ${code}`)); });
      holder.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve(); } });
    });
    return holder;
  } catch (error) { holder.kill(); throw error; }
}
