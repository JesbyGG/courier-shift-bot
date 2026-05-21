import json, os, time
import urllib.request

test_dir = '/root/courier-shift-bot/test_photos/'
test_files = sorted([f for f in os.listdir(test_dir) if f.endswith('.jpg')])

expected = {
    '1eb8e4f8.jpg': 98577, '2f91e4f8.jpg': 140086, '3f3ee4f8.jpg': 57562,
    '4d0be4f8.jpg': 56114, '5f80e4f8.jpg': 86553, '6f73e4f8.jpg': 77395,
    '7f8aa4f8.jpg': 245833, '8a26b8cc.jpg': 350493, '9b14b8cc.jpg': 272168,
    '10c27b8cc.jpg': 178471, '11d19b8cc.jpg': 200586, '12e08b8cc.jpg': 113832,
    '13f04b8cc.jpg': 151883, '14ff3b8cc.jpg': 100278, '15ff4b8cc.jpg': 189874,
    '16ff5b8cc.jpg': 130659, '17ff6b8cc.jpg': 148476, '18ff7b8cc.jpg': 76346,
    '19ff8b8cc.jpg': 67298, '20ff9b8cc.jpg': 28280, '21ffab8cc.jpg': 22899,
    '22ffbb8cc.jpg': 41514, '23ffcb8cc.jpg': 33927, '24ffdb8cc.jpg': 96453,
    '25ffeb8cc.jpg': 122331, '26fffb8cc.jpg': 21033, '27ff0c8cc.jpg': 167842,
    '28ff1c8cc.jpg': 88902, '29ff2c8cc.jpg': 58234, '30ff3c8cc.jpg': 72089,
    '31ff4c8cc.jpg': 105623, '32ff5c8cc.jpg': 47593, '33ff6c8cc.jpg': 193475
}

correct = 0
total = 0
wrong = []
for f in test_files:
    path = os.path.join(test_dir, f)
    t0 = time.time()
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
        req = urllib.request.Request('http://127.0.0.1:9527/', data=data, headers={'Content-Type': 'application/octet-stream'})
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
        elapsed = time.time() - t0
        mileage = result.get('mileage')
        groups = result.get('groups', [])[:3]
        exp = expected.get(f, '?')
        ok = mileage == exp
        if ok:
            correct += 1
        else:
            wrong.append(f'{f}: expected={exp} got={mileage} groups={groups}')
        total += 1
        gstr = ' '.join([f"{g['mileage']}x{g['count']}c{g.get('avg_confidence',0):.2f}km{g.get('has_km',False)}n{g.get('is_noise',False)}" for g in groups])
        print(f'{f}: {mileage} (exp {exp}) {"OK" if ok else "WRONG"} {elapsed:.1f}s | {gstr}')
    except Exception as e:
        print(f'{f}: ERROR {e}')
        total += 1

print(f'\n=== RESULT: {correct}/{total} ===')
for w in wrong:
    print(f'  WRONG: {w}')