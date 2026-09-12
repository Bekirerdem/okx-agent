@echo off
cd /d "%~dp0"
title okx-agent CANLI
:loop
echo [okx-agent] canli baslatiliyor... durdurmak icin Ctrl+C
call bun run src/agent.ts
echo [okx-agent] cikti (kod %ERRORLEVEL%). 5 sn sonra yeniden baslatiliyor... Ctrl+C ile iptal.
timeout /t 5 >nul
goto loop
