@echo off
chcp 65001 >nul 2>&1
title Courier Shift Bot - Restart

echo ============================================
echo   Courier Shift Bot - Restart
echo ============================================
echo.

echo Creating backup before restart...
call "%~dp0backup-now.bat" >nul 2>&1
echo   Backup done.

pm2 restart all
pm2 save

echo.
echo ============================================
echo   Bot restarted.
echo ============================================
echo.
pause