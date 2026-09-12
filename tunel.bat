@echo off
REM Paneli disariya acar: Cloudflare quick tunnel (hesap gerekmez). Once panel.bat calisiyor olmali.
REM Ekranda cikan https://....trycloudflare.com adresini projektorde / telefonda ac. Her baslatmada adres degisir.
cd /d "%~dp0"
cloudflared tunnel --url http://127.0.0.1:8787
pause
