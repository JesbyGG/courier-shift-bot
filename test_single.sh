#!/bin/bash
cd /root/courier-shift-bot
source venv/bin/activate

for f in "$@"; do
    echo "---"
    echo "FILE: $f"
    python3 rapidocr_server.py "$f"
    echo ""
done
