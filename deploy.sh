#!/bin/bash
# Deploy script: pull latest code and restart both processes
set -e
cd /root/courier-shift-bot
git pull origin main
pm2 restart courier-shift-bot --update-env
pm2 restart gemini-ocr-server --update-env
echo "Deploy complete"
