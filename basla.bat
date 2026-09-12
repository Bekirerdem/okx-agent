@echo off
cd /d "%~dp0"
title okx-agent CANLI
echo [okx-agent] canli baslatiliyor... durdurmak icin Ctrl+C
call bun run src/agent.ts
echo.
echo [okx-agent] cikti. Pencereyi kapatmak icin bir tusa basin.
pause >nul
