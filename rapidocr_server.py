#!/usr/bin/env python3
"""
OCR server: Yandex Vision (primary) + rapidocr_onnxruntime (fallback).
Smart selection: prioritise lines with "km", ignore tachometer/speedometer noise.
"""

import json
import os
import sys
import time
import base64
import re
import urllib.request
import ssl
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = Path(__file__).resolve().parent

MIN_MILEAGE = int(os.getenv('OCR_MIN_MILEAGE', '100') or 100)
MAX_MILEAGE = 300000
YANDEX_API_KEY = os.getenv('YANDEX_VISION_API_KEY', '')
YANDEX_ENABLED = bool(YANDEX_API_KEY) and os.getenv('YANDEX_OCR_ENABLED', 'true').lower() != 'false'

_yandex_lock = threading.Lock()
_yandex_last_call = 0.0

NOISE_PATTERNS = [r'x1000', r'r/min', r'rpm', r'km/h', r'mph', r'trip', r'avg', r'speedo', r'tacho']
SPEED_NUBS = {'40', '60', '80', '100', '120', '140', '160', '180', '200', '220', '240', '260', '280'}
KM_MARKERS = re.compile(r'km|км|ml|мл', re.IGNORECASE)
CHAR_SUBSTITUTIONS = str.maketrans({
    'E': '3', 'e': '3', 'O': '0', 'o': '0', 'Q': '0', 'q': '0', 'D': '0',
    'I': '1', 'i': '1', 'l': '1', 'L': '1', '|': '1',
    'S': '5', 's': '5', 'B': '8', 'g': '9',
    'Z': '2', 'z': '2', 'T': '7', 't': '7', 'A': '4', 'a': '4',
})


def is_noise_line(text):
    raw = text.strip()
    if not raw:
        return True
    # If line contains km marker, it's likely the odometer — never filter
    if KM_MARKERS.search(raw):
        return False
    if re.search(r'\b\d{1,2}:\d{2}\b', raw):
        return True
    if re.search(r'\d{1,3}\s*[°º][cCfF]', raw):
        return True
    compact = raw.lower().replace(' ', '')
    if any(re.search(p, compact) for p in NOISE_PATTERNS):
        return True
    if raw in SPEED_NUBS:
        return True
    return False


def extract_numbers(text):
    candidates = []
    for m in re.finditer(r'\d{4,6}', text):
        val = int(m.group())
        if MIN_MILEAGE <= val <= MAX_MILEAGE:
            candidates.append(val)
    cleaned = re.sub(r'[^0-9]', '', text)
    if 4 <= len(cleaned) <= 6:
        val = int(cleaned)
        if MIN_MILEAGE <= val <= MAX_MILEAGE and val not in candidates:
            candidates.append(val)
    return candidates


def smart_select_mileage(lines):
    groups = []
    for line in lines:
        if is_noise_line(line):
            continue
        has_km = bool(KM_MARKERS.search(line))
        nubs = extract_numbers(line)
        for val in nubs:
            groups.append({
                'mileage': val,
                'count': 1,
                'avg_confidence': 1.0,
                'max_confidence': 1.0,
                'has_km': has_km,
                'is_noise': False,
            })
    if not groups:
        return None, groups
    groups.sort(key=lambda g: (not g['has_km'], -(len(str(g['mileage']))), -g['mileage']))
    return groups[0], groups


# ===== Yandex Vision OCR =====

def recognize_with_yandex(image_bytes):
    global _yandex_last_call
    with _yandex_lock:
        now = time.time()
        since_last = now - _yandex_last_call
        if since_last < 1.1:
            time.sleep(1.1 - since_last)
        image_b64 = base64.b64encode(image_bytes).decode('utf-8')
        url = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText'
        payload = {
            'mimeType': 'image/jpeg',
            'languageCodes': ['en', 'ru'],
            'content': image_b64,
            'model': 'page',
        }
        headers = {'Authorization': f'Api-Key {YANDEX_API_KEY}', 'Content-Type': 'application/json'}
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                result = json.loads(resp.read().decode('utf-8'))
            _yandex_last_call = time.time()
        except urllib.error.HTTPError as e:
            _yandex_last_call = time.time()
            return None, f'Yandex HTTP {e.code}'
        except Exception as e:
            return None, f'Yandex error: {e}'

    texts = []
    blocks = result.get('result', {}).get('textAnnotation', {}).get('blocks', [])
    for block in blocks:
        for line in block.get('lines', []):
            text = line.get('text', '').strip()
            if text:
                texts.append(text)
    if not texts:
        pages = result.get('result', {}).get('pages', [])
        for page in pages:
            for block in page.get('blocks', []):
                for line in block.get('lines', []):
                    text = line.get('text', '').strip()
                    if text:
                        texts.append(text)
    return texts, None


# ===== rapidocr_onnxruntime fallback =====

print('Loading RapidOCR fallback...')
import numpy as np
from rapidocr_onnxruntime import RapidOCR
rapidocr_engine = RapidOCR()
print('RapidOCR ready')


def _normalize_text(text):
    text = str(text)
    text = text.translate(CHAR_SUBSTITUTIONS)
    text = re.sub(r'(?<=\d)\s+(?=\d)', '', text)
    text = re.sub(r'[^0-9]', '', text)
    return text


def recognize_with_rapidocr(image_bytes):
    start_time = time.time()
    import cv2
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return None, _format_error('image not readable'), 0

    result = rapidocr_engine(image)
    boxes = result[0] if result else []
    text_items = []
    for box in boxes:
        if len(box) >= 3:
            text_items.append((box[1], box[2]))
        elif len(box) == 2:
            text_items.append((box[1], 0.8))

    print(f'  RapidOCR texts: {text_items}')
    candidates = []
    all_texts = []
    combined_text = ''

    for raw_text, conf in text_items:
        normalized = _normalize_text(raw_text)
        all_texts.append((normalized, float(conf) if conf else 0.8))
        combined_text += ' ' + normalized

    for text, conf in all_texts:
        for match in re.finditer(r'\d{4,6}', text):
            try:
                val = int(match.group())
                if MIN_MILEAGE <= val <= MAX_MILEAGE:
                    candidates.append({'mileage': val, 'conf': conf, 'len': len(match.group())})
            except ValueError:
                pass

    for match in re.finditer(r'\d{4,6}', combined_text):
        try:
            val = int(match.group())
            if MIN_MILEAGE <= val <= MAX_MILEAGE:
                candidates.append({'mileage': val, 'conf': 0.75, 'len': len(match.group())})
        except ValueError:
            pass

    elapsed = time.time() - start_time

    if candidates:
        candidates.sort(key=lambda x: (x['len'] >= 5, x['len'] == 6, x['conf']), reverse=True)
        best = candidates[0]
        print(f'RapidOCR OK: {best["mileage"]} conf={best["conf"]:.3f} {elapsed:.2f}s')
        return best, None, elapsed

    print(f'RapidOCR FAIL {elapsed:.2f}s')
    return None, _format_error('could not recognize'), elapsed


# ===== Response formatting =====

def _format_yandex_result(best, groups, elapsed, lines):
    selected = best or (groups[0] if groups else None)
    if not selected:
        return _format_error('yandex no result')
    return {
        'mileage': selected['mileage'],
        'engine': 'yandex',
        'selected': {
            'mileage': selected['mileage'],
            'count': 1,
            'avg_confidence': 1.0,
            'max_confidence': 1.0,
        },
        'thresholds': {'min_mileage': MIN_MILEAGE, 'max_mileage': MAX_MILEAGE},
        'groups': groups,
        'elapsed': round(elapsed, 2),
    }


def _format_rapidocr_result(best, elapsed):
    return {
        'mileage': best['mileage'],
        'engine': 'rapidocr',
        'selected': {
            'mileage': best['mileage'],
            'count': best['len'],
            'avg_confidence': round(best['conf'], 4),
            'max_confidence': round(best['conf'], 4),
        },
        'thresholds': {'min_mileage': MIN_MILEAGE, 'max_mileage': MAX_MILEAGE},
        'groups': [{
            'mileage': best['mileage'],
            'count': best['len'],
            'avg_confidence': round(best['conf'], 4),
            'max_confidence': round(best['conf'], 4),
            'has_km': True,
            'is_noise': False,
        }],
        'elapsed': round(elapsed, 2),
    }


def _format_error(error_msg):
    return {
        'mileage': None,
        'engine': 'error',
        'selected': {'mileage': None, 'count': 0, 'avg_confidence': 0, 'max_confidence': 0},
        'thresholds': {},
        'groups': [],
        'error': error_msg,
    }


def recognize_text(image_bytes):
    import cv2
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'text_items': []}

    result = rapidocr_engine(image)
    boxes = result[0] if result else []
    text_items = []
    for box in boxes:
        if len(box) >= 3:
            text_items.append({'text': str(box[1]), 'confidence': float(box[2]) if box[2] else 0.8})
        elif len(box) == 2:
            text_items.append({'text': str(box[1]), 'confidence': 0.8})

    return {'text_items': text_items}


# ===== HTTP Server =====

class OcrHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length <= 0 or content_length > 20 * 1024 * 1024:
            self.send_response(400)
            self.end_headers()
            return
        body = self.rfile.read(content_length)
        try:
            if self.path == '/text':
                result = recognize_text(body)
            else:
                result = self._recognize(body)
        except Exception as e:
            import traceback
            traceback.print_exc()
            result = _format_error(str(e))
        response = json.dumps(result, ensure_ascii=True).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        try:
            self.wfile.write(response)
        except BrokenPipeError:
            pass

    def _recognize(self, image_bytes):
        start = time.time()
        if YANDEX_ENABLED:
            lines, err = recognize_with_yandex(image_bytes)
            if lines:
                best, groups = smart_select_mileage(lines)
                elapsed = time.time() - start
                if best:
                    print(f'Yandex OK: {best["mileage"]} {elapsed:.2f}s lines={lines}')
                    return _format_yandex_result(best, groups, elapsed, lines)
                print(f'Yandex no-valid: {elapsed:.2f}s lines={lines}')
        best, err, elapsed = recognize_with_rapidocr(image_bytes)
        if best:
            return _format_rapidocr_result(best, elapsed)
        return err if err else _format_error('all engines failed')

    def do_GET(self):
        if self.path == '/health':
            engines = []
            if YANDEX_ENABLED:
                engines.append('yandex')
            engines.append('rapidocr_onnxruntime_v2')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ok',
                'engine': '+'.join(engines),
                'yandex_enabled': YANDEX_ENABLED,
            }).encode())
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == '--server':
        port = int(os.getenv('RAPIDOCR_PORT', '9527') or 9527)
        server = ThreadingHTTPServer(('127.0.0.1', port), OcrHandler)
        print(f'OCR server listening on 127.0.0.1:{port}', flush=True)
        print(f'  Yandex Vision: {"ENABLED" if YANDEX_ENABLED else "DISABLED (set YANDEX_VISION_API_KEY)"}', flush=True)
        print(f'  RapidOCR fallback: LOADED', flush=True)
        print(f'  MIN_MILEAGE={MIN_MILEAGE} MAX_MILEAGE={MAX_MILEAGE}', flush=True)
        server.serve_forever()
    else:
        print(json.dumps({'mileage': None, 'error': 'usage: rapidocr_server.py --server'}))


if __name__ == '__main__':
    main()
