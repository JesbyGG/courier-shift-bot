@echo off
chcp 65001 >nul
title Deploy Courier Shift Bot

echo ============================================
echo   Deploy to VPS
echo ============================================
echo.

:: 1. Git commit + push
echo [1/3] Checking for changes...
git add -A
git diff --cached --quiet
if %errorlevel% equ 0 (
    echo   No changes to commit.
    set HAS_CHANGES=0
) else (
    echo   Changes found. Committing...
    git commit -m "update: %date% %time%"
    set HAS_CHANGES=1
)

if %HAS_CHANGES% equ 1 (
    echo [2/3] Pushing to GitHub...
    git push origin main
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: Git push failed.
        pause
        exit /b 1
    )
) else (
    echo [2/3] Skipping push (no changes).
)

:: 2. Update VPS
echo [3/3] Updating VPS...
ssh -i "%USERPROFILE%\.ssh\vps-deploy-key" -o StrictHostKeyChecking=no -o RequestTTY=no root@103.54.19.218 "cd ~/courier-shift-bot && git fetch origin main && git reset --hard origin/main && pm2 restart courier-shift-bot && pm2 status"

echo.
echo ============================================
echo   Deploy complete!
echo ============================================
pause
