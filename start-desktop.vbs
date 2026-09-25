Set WshShell = CreateObject("WScript.Shell")
strScriptPath = WScript.ScriptFullName
Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objFile = objFSO.GetFile(strScriptPath)
strProjectDir = objFSO.GetParentFolderName(objFile)
WshShell.CurrentDirectory = strProjectDir

' Launch desktop app silently with no lingering console window (0 = hidden window)
WshShell.Environment("PROCESS")("IS_DESKTOP") = "1"
WshShell.Environment("PROCESS")("DESKTOP_APP") = "true"
WshShell.Run "cmd.exe /c npm run desktop", 0, False
