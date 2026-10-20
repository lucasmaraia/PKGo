# Cria atalhos do PKG Sender na Área de Trabalho e no Menu Iniciar.
$dir = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
    $link = $shell.CreateShortcut((Join-Path $folder 'PKG Sender.lnk'))
    $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $link.Arguments = '"' + (Join-Path $dir 'PKG Sender.vbs') + '"'
    $link.WorkingDirectory = $dir
    $link.IconLocation = (Join-Path $dir 'assets\icon.ico') + ',0'
    $link.Description = 'Instale PKGs no PS4 pela rede'
    $link.Save()
    Write-Host "Atalho criado: $($link.FullName)"
}
