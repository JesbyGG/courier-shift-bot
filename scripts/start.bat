@echo off
chcp 65001 >nul 2>&1
title Courier Shift Bot - Start

echo ============================================
echo   Courier Shift Bot - Start
echo ============================================
echo.

pm2 resurrect 2>nul
pm2 start "%~dp0ecosystem.config.js"
pm2 save

echo.
echo ============================================
echo   Bot is running!
echo   Use 'stop.bat' to stop.
echo ============================================
echo.
pause