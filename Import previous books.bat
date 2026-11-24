@echo off
setlocal
cd /d "%~dp0"
node tools/import-books.mjs %*
pause
