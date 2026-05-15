@echo off
chcp 65001 >nul 2>&1
title Courier Shift Bot - Status

echo ============================================
echo   Courier Shift Bot - Status
echo ============================================
echo.

pm2 list

echo.
echo Last 20 log lines:
echo.
pm2 logs --lines 20 --nostream

echo.
pause