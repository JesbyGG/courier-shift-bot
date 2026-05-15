@echo off
chcp 65001 >nul
title Deploy Courier Shift Bot

echo ============================================
echo   Deploy to VPS
echo ============================================
echo.

echo [1/3] Checking for changes...
git add -A
git status --porcelain > "%TEMP%\git_status.txt"
for /f %%A in ('type "%TEMP%\git_status.txt" ^| find /c /v ""') do set COUNT=%%A

if "%COUNT%"=="0" (
    echo   No changes to commit.
) else (
    echo   Changes found. Committing...
    git commit -m "update: %date% %time%"
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: Git commit failed.
        pause
        exit /b 1
    )
    echo   Pushing to GitHub...
    git push origin main
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: Git push failed.
        pause
        exit /b 1
    )
)

echo [2/3] Done with GitHub.
echo.
echo [3/3] Updating VPS...
ssh -i "%USERPROFILE%\.ssh\vps-deploy-key" -o StrictHostKeyChecking=no -o RequestTTY=no -o ConnectTimeout=15 root@103.54.19.218 "cd ~/courier-shift-bot && git fetch origin main && git reset --hard origin/main && pm2 restart courier-shift-bot && pm2 status"

echo.
echo ============================================
echo   Deploy complete!
echo ============================================
pause
