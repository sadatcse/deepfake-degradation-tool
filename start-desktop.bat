@echo off
setlocal
cd /d "%~dp0"
title DeepFake Video Degradation Tool

echo Starting DeepFake Video Degradation Tool...
set IS_DESKTOP=1
set DESKTOP_APP=true
npm run desktop
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Application failed to start.
    pause
)
