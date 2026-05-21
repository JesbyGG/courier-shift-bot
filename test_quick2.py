import json, os, time, urllib.request

test_dir = '/root/courier-shift-bot/test_photos/'
files = ['1eb8e4f8.jpg', '11d19b8cc.jpg', '49d8703c-50cf-4d2d-b79d-90d6b8a2fd52.jpg']
if not os.path.exists(os.path.join(test_dir, files[0])):
    all_files = sorted([f for f in os.listdir(test_dir) if f.endswith('.jpg')])
    files = all_files[:5]

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
        groups = result.get('groups', [])[:4]
        gstr = ' | '.join([f"{g['mileage']}x{g['count']}c{g['avg_confidence']:.2f}km{g['has_km']}n{g['is_noise']}" for g in groups])
        print(f'{f}: {mileage} {elapsed:.1f}s | {gstr}')
    except Exception as e:
        elapsed = time.time() - t0
        print(f'{f}: ERROR {e} ({elapsed:.1f}s)')