@echo off
cd /d "%~dp0"
start "Dorm Manager Server" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "Dorm Manager" "http://localhost:3000"
exit
