#!/usr/bin/env python3
# rapidocr_server.py — OCR for odometer photos using rapidocr_onnxruntime.

import json
import os
import sys
import time
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
import numpy as np
from rapidocr_onnxruntime import RapidOCR

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = Path(__file__).resolve().parent
MIN_MILEAGE = int(os.getenv('OCR_MIN_MILEAGE', '100') or 100)
MAX_MILEAGE = 300000

# Letter-to-digit substitutions for OCR cleanup
CHAR_SUBSTITUTIONS = str.maketrans({
    'E': '3', 'e': '3',
    'O': '0', 'o': '0', 'Q': '0', 'q': '0', 'D': '0',
    'I': '1', 'i': '1', 'l': '1', 'L': '1', '|': '1',
    'S': '5', 's': '5',
    'B': '8',
    'g': '9',
    'Z': '2', 'z': '2',
    'T': '7', 't': '7',
    'A': '4', 'a': '4',
})

print('RapidOCR loading...')
engine = RapidOCR()
print('RapidOCR ready')


def _normalize_text(text):
    """Replace lookalike letters with digits and clean up."""
    text = str(text)
    # Apply character substitutions first
    text = text.translate(CHAR_SUBSTITUTIONS)
    # Remove whitespace inside digit groups (e.g. "1 14 136" -> "114136")
    text = re.sub(r'(?<=\d)\s+(?=\d)', '', text)
    # Strip all remaining non-digit characters
    text = re.sub(r'[^0-9]', '', text)
    return text


def _extract_mileage(text_items):
    """Extract mileage from OCR text items. Accepts any 4-6 digit number."""
    candidates = []
    all_texts = []
    combined_text = ''

    # Step 1: normalize all texts and collect
    for raw_text, conf in text_items:
        normalized = _normalize_text(raw_text)
        all_texts.append((normalized, float(conf) if conf else 0.8))
        combined_text += ' ' + normalized

    # Step 2: find 4-6 digit numbers in each individual text item
    for text, conf in all_texts:
        # Find all 4-6 digit numbers
        for match in re.finditer(r'\d{4,6}', text):
            try:
                val = int(match.group())
                if MIN_MILEAGE <= val <= MAX_MILEAGE:
                    candidates.append({
                        'mileage': val,
                        'conf': conf,
                        'source': 'item',
                        'len': len(match.group())
                    })
            except ValueError:
                pass

    # Step 3: find 4-6 digit numbers in combined text (catches split digits)
    for match in re.finditer(r'\d{4,6}', combined_text):
        try:
            val = int(match.group())
            if MIN_MILEAGE <= val <= MAX_MILEAGE:
                candidates.append({
                    'mileage': val,
                    'conf': 0.75,  # lower confidence for combined
                    'source': 'combined',
                    'len': len(match.group())
                })
        except ValueError:
            pass

    if not candidates:
        return None

    # Prefer longer numbers (5-6 digits), then higher confidence
    candidates.sort(key=lambda x: (
        x['len'] >= 5,      # prefer 5-6 digits over 4
        x['len'] == 6,      # prefer 6 digits over 5
        x['conf'],          # higher confidence
        x['source'] == 'item'  # prefer direct over combined
    ), reverse=True)

    return candidates[0]


def recognize(image_bytes, options=None):
    options = options or {}
    start_time = time.time()

    nparr = np.frombuffer(image_bytes, np.uint8)
    import cv2
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return _format_error('image not readable')

    result = engine(image)
    boxes = result[0] if result else []

    text_items = []
    for box in boxes:
        if len(box) >= 3:
            text_items.append((box[1], box[2]))
        elif len(box) == 2:
            text_items.append((box[1], 0.8))

    print(f'  OCR texts: {text_items}')

    best = _extract_mileage(text_items)
    elapsed = time.time() - start_time

    if best:
        mileage = best['mileage']
        conf = best['conf']
        print(f'RapidOCR OK: {mileage} conf={conf:.3f} {elapsed:.2f}s')
        return _format_result(mileage, conf, conf, elapsed)

    print(f'RapidOCR FAIL {elapsed:.2f}s')
    return _format_error('could not recognize')


def _format_result(mileage, avg_conf, max_conf, elapsed):
    return {
        'mileage': mileage,
        'selected': {
            'mileage': mileage,
            'count': len(str(mileage)),
            'avg_confidence': round(avg_conf, 4),
            'max_confidence': round(max_conf, 4),
        },
        'thresholds': {
            'min_mileage': MIN_MILEAGE,
            'max_mileage': MAX_MILEAGE,
        },
        'groups': [{
            'mileage': mileage,
            'count': len(str(mileage)),
            'avg_confidence': round(avg_conf, 4),
            'max_confidence': round(max_conf, 4),
            'has_km': True,
            'is_noise': False,
            'is_upper': False,
        }],
        'elapsed': round(elapsed, 2),
    }


def _format_error(error_msg):
    return {
        'mileage': None,
        'selected': {'mileage': None, 'count': 0, 'avg_confidence': 0, 'max_confidence': 0},
        'thresholds': {},
        'groups': [],
        'error': error_msg,
    }


def recognize_text(image_bytes):
    return {'text_items': []}


class RapidOcrHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length <= 0 or content_length > 20 * 1024 * 1024:
            self.send_response(400)
            self.end_headers()
            return

        body = self.rfile.read(content_length)
        try:
            result = recognize(body) if self.path != '/text' else recognize_text(body)
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

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok","engine":"rapidocr_onnxruntime_v2"}')
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
        server = ThreadingHTTPServer(('127.0.0.1', port), RapidOcrHandler)
        print(f'RapidOCR server v2 listening on 127.0.0.1:{port}', flush=True)
        server.serve_forever()
    else:
        print(json.dumps({'mileage': None, 'error': 'usage: rapidocr_server.py --server'}))


if __name__ == '__main__':
    main()
