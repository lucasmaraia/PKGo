' Abre o PKG Sender em janela propria, sem a janela preta do console.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
On Error Resume Next
sh.Run "node """ & dir & "\server.mjs"" --app", 0, False
If Err.Number <> 0 Then MsgBox "Node.js nao foi encontrado. Instale em https://nodejs.org e tente de novo.", 16, "PKG Sender"
