@echo off
cd /d "%~dp0"
title okx-agent PANEL
start "" http://localhost:8787
call bun run src/dashboard.ts
pause >nul
