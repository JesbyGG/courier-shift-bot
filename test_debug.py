import json, os, time, urllib.request

test_dir = '/root/courier-shift-bot/test_photos/'
f = '0c19c0a9-8778-48e9-b3c1-9aa8473fea9f.jpg'
path = os.path.join(test_dir, f)
t0 = time.time()
with open(path, 'rb') as fh:
    data = fh.read()
req = urllib.request.Request('http://127.0.0.1:9527/', data=data, headers={'Content-Type': 'application/octet-stream'})
with urllib.request.urlopen(req, timeout=180) as resp:
    result = json.loads(resp.read().decode())
elapsed = time.time() - t0
print(f'{elapsed:.1f}s')
print(json.dumps(result, indent=2))