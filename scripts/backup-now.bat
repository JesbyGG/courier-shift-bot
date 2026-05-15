@echo off
chcp 65001 >nul 2>&1
title Courier Shift Bot - Backup

echo ============================================
echo   Courier Shift Bot - Manual Backup
echo ============================================
echo.

if not exist "%~dp0backups" mkdir "%~dp0backups"

for /f "tokens=*" %%d in ('powershell -command "(Get-Date).ToString('yyyy-MM-dd_HH-mm-ss')"') do set BACKUP_TS=%%d

if exist "%~dp0database.sqlite" (
  copy "%~dp0database.sqlite" "%~dp0backups\database-manual-%BACKUP_TS%.sqlite" >nul
  echo   database.sqlite backed up
) else (
  echo   database.sqlite not found, skipping
)

if exist "%~dp0fun-reactions.json" (
  copy "%~dp0fun-reactions.json" "%~dp0backups\fun-reactions-manual-%BACKUP_TS%.json" >nul
  echo   fun-reactions.json backed up
) else (
  echo   fun-reactions.json not found, skipping
)

echo.
echo ============================================
echo   Backup complete!
echo   Files saved to: %~dp0backups
echo ============================================
echo.
pause