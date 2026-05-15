#!/bin/bash
cd /root/courier-shift-bot
for f in test_photos/*.jpg; do
    name=$(basename "$f")
    result=$(curl -s -X POST http://127.0.0.1:9527/ -H 'Content-Type: application/octet-stream' --data-binary @"$f" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("mileage","NULL"))' 2>/dev/null)
    echo "$name => $result"
done