Set WshShell = CreateObject("WScript.Shell")
strScriptPath = WScript.ScriptFullName
Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objFile = objFSO.GetFile(strScriptPath)
strProjectDir = objFSO.GetParentFolderName(objFile)
WshShell.CurrentDirectory = strProjectDir

' Launch desktop app silently with no lingering console window (0 = hidden window)
WshShell.Run "cmd.exe /c npm run desktop", 0, False
