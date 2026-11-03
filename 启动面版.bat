@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "F:\nodeJs\node.exe" "%~dp0bd-ui.mjs"
timeout /t 2 >nul
start "" http://127.0.0.1:8787
