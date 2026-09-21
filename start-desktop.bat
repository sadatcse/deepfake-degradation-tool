@echo off
setlocal
cd /d "%~dp0"
title DeepFake Video Degradation Tool

echo Starting DeepFake Video Degradation Tool...
npm run desktop
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Application failed to start.
    pause
)
