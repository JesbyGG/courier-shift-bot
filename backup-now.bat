@echo off
chcp 65001 >nul 2>&1
title Courier Shift Bot - Backup

echo ============================================
echo   Courier Shift Bot - Manual Backup
echo ============================================
echo.

if not exist "%~dp0backups" mkdir "%~dp0backups"

for %%f in (users.json states.json fun-reactions.json) do (
  if exist "%~dp0%%f" (
    for /f "tokens=*" %%d in ('powershell -command "(Get-Date).ToString('yyyy-MM-dd_HH-mm-ss')"') do (
      copy "%~dp0%%f" "%~dp0backups\%%~nf-manual-%%d.json" >nul
      echo   %%f backed up
    )
  ) else (
    echo   %%f not found, skipping
  )
)

echo.
echo ============================================
echo   Backup complete!
echo   Files saved to: %~dp0backups
echo ============================================
echo.
pause