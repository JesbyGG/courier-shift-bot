#!/bin/bash
cd /root/courier-shift-bot
for f in test_photos/8a26b8cc-5d7e-4b2b-a01a-d1243c6dba5c.jpg test_photos/7f8aa4f8-5328-436d-b4f2-29335c5d6596.jpg test_photos/17152654-0cb2-406c-b915-8a0be7a11f84.jpg test_photos/8c0ab95a-57c7-4b0e-8a30-af52797177cd.jpg test_photos/694542d9-c5ed-4ec2-89ca-0f006cb6b1c4.jpg test_photos/fad97c02-644b-42b6-864e-c6d5848f0e06.jpg test_photos/3edec63c-163b-4507-a321-47b7665dafe6.jpg test_photos/f2af9836-4ed9-4aa1-9fb4-ffdd3c64f466.jpg; do
    name=$(basename "$f")
    result=$(curl -s -X POST http://127.0.0.1:9527/ -H 'Content-Type: application/octet-stream' --data-binary @"$f")
    mileage=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('mileage','NULL'))" 2>/dev/null)
    echo "$name => $mileage"
done