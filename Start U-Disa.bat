@echo off
setlocal
cd /d "%~dp0"
title U-Disa
where node >nul 2>nul
if errorlevel 1 goto missing
node --version
node tools/launch.mjs %*
if errorlevel 1 pause
exit /b
:missing
echo Install Node.js 24 LTS from https://nodejs.org and start U-Disa again.
pause
