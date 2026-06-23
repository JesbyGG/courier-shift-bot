#!/usr/bin/env python3
"""
OCR server: Gemini 2.5 Flash Lite (mileage + text) + Tesseract (text fallback).
"""

import json
import os
import sys
import time
import base64
import re
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = Path(__file__).resolve().parent

MIN_MILEAGE = int(os.getenv('OCR_MIN_MILEAGE', '100') or 100)
MAX_MILEAGE = 300000
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')
if not GEMINI_API_KEY:
    try:
        _env_path = os.path.join(BASE_DIR, '.env')
        with open(_env_path) as _f:
            for _line in _f:
                _line = _line.strip()
                if _line.startswith('GEMINI_API_KEY='):
                    _val = _line.split('=', 1)[1].strip()
                    GEMINI_API_KEY = _val.strip('"\'')
                    break
    except Exception:
        pass
GEMINI_ENABLED = bool(GEMINI_API_KEY)

GEMINI_MAX_DIM = int(os.getenv('GEMINI_MAX_DIM', '1200') or 1200)
GEMINI_JPEG_QUALITY = int(os.getenv('GEMINI_JPEG_QUALITY', '85') or 85)
GEMINI_MAX_RETRIES = int(os.getenv('GEMINI_MAX_RETRIES', '3') or 3)

NOISE_PATTERNS = [r'x1000', r'r/min', r'rpm', r'km/h', r'mph', r'trip', r'avg', r'speedo', r'tacho']
KM_MARKERS = re.compile(r'km|км|ml|мл', re.IGNORECASE)


def is_noise_line(text):
    raw = text.strip()
    if not raw:
        return True
    if re.search(r'\b\d{1,2}:\d{2}\b', raw):
        return True
    if re.search(r'\d{1,3}\s*[°º][cCfF]', raw):
        return True
    compact = raw.lower().replace(' ', '')
    if any(re.search(p, compact) for p in NOISE_PATTERNS):
        return True
    # Lines without any digits are also noise
    if not re.search(r'\d', compact):
        return True
    return False


def extract_numbers(text):
    candidates = []
    covered = set()

    # Combine digits separated by spaces first (e.g. "8935 7" -> "89357")
    for m in re.finditer(r'\d{1,3}(?:\s+\d{1,3})+', text):
        val = int(re.sub(r'\s+', '', m.group()))
        if MIN_MILEAGE <= val <= MAX_MILEAGE:
            candidates.append(val)
            for i in range(m.start(), m.end()):
                covered.add(i)

    # Then contiguous digit groups (3-6 digits to match MIN_MILEAGE default of 100)
    for m in re.finditer(r'\d{3,6}', text):
        if any(i in covered for i in range(m.start(), m.end())):
            continue
        val = int(m.group())
        if MIN_MILEAGE <= val <= MAX_MILEAGE and val not in candidates:
            candidates.append(val)
    return candidates


def smart_select_mileage(lines):
    groups = []
    for line in lines:
        if is_noise_line(line):
            continue
        has_km = bool(KM_MARKERS.search(line))
        for val in extract_numbers(line):
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
    # Prefer: line with km marker, longer number, larger number
    groups.sort(key=lambda g: (not g['has_km'], -(len(str(g['mileage']))), -g['mileage']))
    return groups[0], groups


# ===== Gemini 2.5 Flash Lite =====

def optimize_image_for_ocr(image_bytes, max_dim=None, quality=None):
    if max_dim is None:
        max_dim = GEMINI_MAX_DIM
    if quality is None:
        quality = GEMINI_JPEG_QUALITY
    import cv2
    import numpy as np
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return image_bytes
    h, w = img.shape[:2]
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    _, encoded = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return encoded.tobytes()


def _call_gemini(image_bytes, system_prompt, max_retries=GEMINI_MAX_RETRIES):
    """Send image to Gemini and return lines list. Retries on 503."""
    for attempt in range(max_retries):
        lines, err = _call_gemini_once(image_bytes, system_prompt)
        if lines:
            return lines, None
        if err and '503' in str(err) and attempt < max_retries - 1:
            delay = 2 ** (attempt + 1)
            print(f'Gemini 503, retry {attempt+2}/{max_retries} in {delay}s')
            time.sleep(delay)
            continue
        return None, err
    return None, 'Gemini unavailable after retries'


def _call_gemini_once(image_bytes, system_prompt):
    """Send image to Gemini and return lines list."""
    api_key = GEMINI_API_KEY
    if not api_key:
        return None, 'Gemini API key not configured'

    optimized = optimize_image_for_ocr(image_bytes)
    image_b64 = base64.b64encode(optimized).decode('utf-8')

    url = f'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key={api_key}'
    payload = {
        "contents": [{
            "parts": [
                {"text": system_prompt},
                {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}}
            ]
        }]
    }
    headers = {'Content-Type': 'application/json'}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers=headers,
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return None, f'Gemini HTTP {e.code} ({e.read().decode()[:200]})'
    except Exception as e:
        return None, f'Gemini error: {e}'

    try:
        text = result['candidates'][0]['content']['parts'][0]['text']
    except (KeyError, IndexError):
        return None, f'Gemini unexpected response: {json.dumps(result, ensure_ascii=True)[:300]}'

    if not text or not text.strip():
        return None, 'Gemini returned empty text'

    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    return lines, None


def recognize_with_gemini(image_bytes):
    """Mileage OCR: returns (lines, error)."""
    return _call_gemini(image_bytes, "You are analyzing a car dashboard photo. "
                         "Find the total odometer mileage (the largest number shown, usually with 'km' or 'км' nearby). "
                         "Important: some digital displays group digits with a small gap, e.g. '8935 7 km' means 89357 km. "
                         "Read the full odometer value including the last digit(s) even if there is a gap. "
                         "Ignore: time, temperature, fuel consumption, speed, RPM, trip meters. "
                         "Reply ONLY with the full number and the unit, e.g. '89357 km'. No extra text.")


def recognize_text_with_gemini(image_bytes):
    """Reconciliation OCR: returns (lines, error)."""
    return _call_gemini(image_bytes, "You are reading a delivery app order statistics page. "
                         "1) CASH: Find the 'Наличные' (cash) payment method line. "
                         "It shows format 'Наличные X / Y ₽' where Y is cash amount in rubles. "
                         "If there is no amount shown or amount is 0,00, reply: CASH: 0. "
                         "Otherwise reply the cash amount with comma as decimal separator. "
                         "Important: read the FULL number including thousands separator. "
                         "For example, '10 404,37' means ten thousand four hundred four rubles 37 kopecks. "
                         "Reply: CASH: 10 404,37 (with space as thousands separator). "
                         "2) ORDERS: Find the large number under 'ЗАКАЗОВ ЗА СЕГОДНЯ' (total orders for today). "
                         "This is the TOTAL order count across ALL payment methods. "
                         "Do NOT confuse with individual counts like 'Наличные 5' or 'Карта 3'. "
                         "Reply ONLY in this exact format: "
                         "CASH: <amount> ORDERS: <total integer> "
                         "Example: CASH: 10 404,37 ORDERS: 22")


# ===== Response formatting =====

def _format_gemini_result(best, groups, elapsed, lines):
    selected = best or (groups[0] if groups else None)
    if not selected:
        return _format_error('gemini no result')
    return {
        'mileage': selected['mileage'],
        'engine': 'gemini',
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
    """Text recognition for /text endpoint. Gemini -> Tesseract fallback."""
    import cv2
    import numpy as np
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'text_items': []}

    # 1. Gemini (primary)
    if GEMINI_ENABLED:
        lines, err = recognize_text_with_gemini(image_bytes)
        if lines:
            print(f'Gemini text: {len(lines)} lines, preview: {lines[:3]}')
            return {'text_items': [{'text': line, 'confidence': 0.95} for line in lines]}
        print(f'Gemini text fail: {err}')

    # 2. Tesseract (fallback)
    try:
        import pytesseract
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        text = pytesseract.image_to_string(rgb, lang='rus+eng', timeout=30)
        if text and text.strip():
            lines = [line.strip() for line in text.split('\n') if line.strip()]
            print(f'Tesseract text: {len(lines)} lines, preview: {lines[:3]}')
            return {'text_items': [{'text': line, 'confidence': 0.9} for line in lines]}
        print('Tesseract returned empty text')
    except ImportError:
        print('pytesseract not installed')
    except Exception as e:
        print(f'Tesseract error: {e}')

    return {'text_items': []}


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
        """Mileage recognition: Gemini only."""
        start = time.time()

        if GEMINI_ENABLED:
            lines, err = recognize_with_gemini(image_bytes)
            if lines:
                best, groups = smart_select_mileage(lines)
                elapsed = time.time() - start
                if best:
                    print(f'Gemini OK: {best["mileage"]} {elapsed:.2f}s lines={lines}')
                    return _format_gemini_result(best, groups, elapsed, lines)
                print(f'Gemini no-valid ({err}): {elapsed:.2f}s lines={lines}')
            else:
                print(f'Gemini fail: {err}')

        return _format_error('Gemini failed or not configured')

    def do_GET(self):
        if self.path == '/health':
            engines = []
            if GEMINI_ENABLED:
                engines.append('gemini')
            try:
                import pytesseract
                engines.append('tesseract')
            except ImportError:
                pass
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ok',
                'engine': '+'.join(engines),
                'gemini_enabled': GEMINI_ENABLED,
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
        port = int(os.getenv('GEMINI_OCR_PORT', '9527') or 9527)
        server = ThreadingHTTPServer(('127.0.0.1', port), OcrHandler)
        print(f'OCR server listening on 127.0.0.1:{port}', flush=True)
        print(f'  Gemini 2.5 Flash Lite: {"ENABLED" if GEMINI_ENABLED else "DISABLED (set GEMINI_API_KEY)"}', flush=True)
        print(f'  Image optimize: {GEMINI_MAX_DIM}px, JPEG q{GEMINI_JPEG_QUALITY}', flush=True)
        try:
            import pytesseract
            print(f'  Tesseract: AVAILABLE (rus+eng)', flush=True)
        except ImportError:
            print(f'  Tesseract: NOT INSTALLED (pip install pytesseract)', flush=True)
        print(f'  MIN_MILEAGE={MIN_MILEAGE} MAX_MILEAGE={MAX_MILEAGE}', flush=True)
        server.serve_forever()
    else:
        print(json.dumps({'mileage': None, 'error': 'usage: gemini_ocr_server.py --server'}))


if __name__ == '__main__':
    main()
