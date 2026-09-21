@echo off
setlocal
cd /d "%~dp0"
title DeepFake Video Degradation Tool - Setup

echo ==========================================================
echo   DeepFake Video Degradation Tool - Desktop Setup
echo ==========================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-desktop.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Setup encountered an issue. See details above.
    pause
    exit /b %errorlevel%
)

echo.
pause
