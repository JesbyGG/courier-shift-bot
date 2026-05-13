@echo off
chcp 65001 >nul 2>&1
title Courier Shift Bot - Stop

echo ============================================
echo   Courier Shift Bot - Stop
echo ============================================
echo.

echo Creating backup before stop...
call "%~dp0backup-now.bat" >nul 2>&1
echo   Backup done.

pm2 stop all
pm2 save

echo.
echo ============================================
echo   Bot stopped.
echo   Use 'start.bat' to start again.
echo ============================================
echo.
pause