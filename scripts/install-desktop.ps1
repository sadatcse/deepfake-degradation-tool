$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  DeepFake Video Degradation Tool - Desktop Setup" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

$projectDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectDir

# 1. Check Node.js
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVer = & node -v
    Write-Host "  -> Found Node.js: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Node.js is not found on PATH!" -ForegroundColor Red
    Write-Host "  Please install Node.js 20 or newer from https://nodejs.org/" -ForegroundColor Red
    Exit 1
}

# 2. Check FFmpeg
Write-Host "[2/5] Checking FFmpeg & FFprobe..." -ForegroundColor Yellow
try {
    $ffOut = & ffmpeg -version 2>&1
    Write-Host "  -> Found FFmpeg on system PATH" -ForegroundColor Green
} catch {
    Write-Host "  NOTE: FFmpeg not detected on system PATH." -ForegroundColor DarkYellow
    Write-Host "  You can install it with: winget install Gyan.FFmpeg" -ForegroundColor DarkYellow
    Write-Host "  Or configure FFMPEG_PATH in .env" -ForegroundColor DarkYellow
}

# 3. Install dependencies
Write-Host "[3/5] Installing npm dependencies..." -ForegroundColor Yellow
& npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: npm install failed!" -ForegroundColor Red
    Exit 1
}
Write-Host "  -> Dependencies installed successfully." -ForegroundColor Green

# 4. Build Next.js
Write-Host "[4/5] Building application for desktop production..." -ForegroundColor Yellow
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: npm run build failed!" -ForegroundColor Red
    Exit 1
}
Write-Host "  -> Production build complete." -ForegroundColor Green

# 5. Create Desktop Shortcut
Write-Host "[5/5] Creating Desktop Shortcut..." -ForegroundColor Yellow
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutFile = Join-Path $desktopPath "DeepFake Video Degradation Tool.lnk"
$launcherPath = Join-Path $projectDir "start-desktop.vbs"
$iconPath = Join-Path $projectDir "assets\icon.ico"

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutFile)
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$launcherPath`""
$shortcut.WorkingDirectory = "$projectDir"
$shortcut.Description = "DeepFake Bulk Video Degradation Tool"
if (Test-Path $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Save()

Write-Host "  -> Desktop shortcut created:" -ForegroundColor Green
Write-Host "     $shortcutFile" -ForegroundColor Cyan
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  INSTALLATION COMPLETED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "  You can now start the app in ONE CLICK by double-clicking" -ForegroundColor Green
Write-Host "  the 'DeepFake Video Degradation Tool' shortcut on your Desktop!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
