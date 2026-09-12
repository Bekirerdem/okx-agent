@echo off
cd /d "%~dp0"
title okx-agent CANLI
echo [okx-agent] canli baslatiliyor... durdurmak icin Ctrl+C
bun run src/agent.ts
pause
