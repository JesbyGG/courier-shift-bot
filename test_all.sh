#!/bin/bash
cd /root/courier-shift-bot
source venv/bin/activate

for f in test_photos/*.jpg; do
    result=$(python3 rapidocr_server.py "$f" 2>/dev/null)
    mileage=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('mileage','NULL'))" 2>/dev/null)
    echo "$(basename $f) => $mileage"
done