import json, os, time, urllib.request

test_dir = '/root/courier-shift-bot/test_photos/'
files = sorted([f for f in os.listdir(test_dir) if f.endswith('.jpg')])

for f in files:
    path = os.path.join(test_dir, f)
    t0 = time.time()
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
        req = urllib.request.Request('http://127.0.0.1:9527/', data=data, headers={'Content-Type': 'application/octet-stream'})
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode())
        elapsed = time.time() - t0
        mileage = result.get('mileage')
        groups = result.get('groups', [])[:3]
        gstr = ' | '.join([f"{g['mileage']}x{g['count']}c{g['avg_confidence']:.2f}km{g['has_km']}" for g in groups])
        print(f'{f}: {mileage} {elapsed:.1f}s | {gstr}')
    except Exception as e:
        elapsed = time.time() - t0
        print(f'{f}: ERROR {e} ({elapsed:.1f}s)')