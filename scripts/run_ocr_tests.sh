#!/bin/bash
cd /root/courier-shift-bot
source venv/bin/activate

echo '========================================'
echo 'OCR Test Runner'
echo '========================================'

for img in test_photos/*.{jpg,jpeg,png,webp,JPG,JPEG,PNG,WEBP}; do
    [ -f "$img" ] || continue
    echo ''
    echo '----------------------------------------'
    echo "FILE: $img"
    echo '----------------------------------------'
    python3 rapidocr_server.py "$img"
    echo ''
done

echo '========================================'
echo 'Tests complete'
echo '========================================'
