#!/bin/bash
cd /root/courier-shift-bot
source venv/bin/activate

FILES="
17152654-0cb2-406c-b915-8a0be7a11f84
3edec63c-163b-4507-a321-47b7665dafe6
49d8703c-50cf-4d2d-b79d-90d6b8a2fd52
7dac9eb3-25f8-462e-9979-bee5d7615371
7f8aa4f8-5328-436d-b4f2-29335c5d6596
8a26b8cc-5d7e-4b2b-a01a-d1243c6dba5c
cdeeb688-0b8b-4427-b905-9e8a04336d23
f2af9836-4ed9-4aa1-9fb4-ffdd3c64f466
"

for f in $FILES; do
    echo "---"
    echo "FILE: $f"
    python3 rapidocr_server.py "test_photos/${f}.jpg" 2>/dev/null
    echo ""
done