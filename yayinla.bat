@echo off
REM Panelin anlik goruntusunu 5 dakikada bir Cloudflare Pages'e yayinlar. Sunucu gerekmez; laptop kapansa da son hal acik kalir.
cd /d "%~dp0"
:loop
call bun run scripts/export_panel.ts
call wrangler pages deploy dist --project-name okx-agent-panel --branch master --commit-dirty=true
echo.
echo 5 dakika sonra tekrar yayinlanacak. Kapatmak icin pencereyi kapat.
timeout /t 300 /nobreak >nul
goto loop
