// Native Windows file/folder pickers. The browser cannot reveal file paths,
// and the server needs real paths to stream PKGs to the PS4.
import {execFile} from 'node:child_process';

function runPowerShell(script) {
  const full = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$owner=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};' + script;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')],
      {windowsHide: true, maxBuffer: 4 << 20},
      (err, stdout) => err ? reject(err) : resolve(stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
  });
}

export const pickFiles = () => runPowerShell(
  "$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Title='Escolha os PKGs';" +
  "$d.Filter='Pacotes PS4 (*.pkg)|*.pkg';$d.Multiselect=$true;" +
  "if($d.ShowDialog($owner) -eq 'OK'){$d.FileNames}");

export const pickFolder = () => runPowerShell(
  "$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='Escolha a pasta com seus PKGs';" +
  "if($d.ShowDialog($owner) -eq 'OK'){$d.SelectedPath}");
