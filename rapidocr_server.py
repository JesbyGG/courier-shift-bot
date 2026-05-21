import json
import os
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ENGINE = RapidOCR()
_engine_lock = threading.Lock()

ENGINE_TEXT = None
try:
    from rapidocr import RapidOCR as RapidOCRv3, LangRec, OCRVersion, LangDet
    ENGINE_TEXT = RapidOCRv3(params={
        'Rec.ocr_version': OCRVersion.PPOCRV5,
        'Rec.lang_type': LangRec.ESLAV,
        'Det.lang_type': LangDet.MULTI,
    })
    print('RapidOCR eslav engine loaded', flush=True)
except Exception as e:
    print(f'RapidOCR eslav engine failed: {e}, falling back to default', flush=True)
    ENGINE_TEXT = ENGINE

MIN_MILEAGE = int(os.getenv('OCR_MIN_MILEAGE', '1000') or 1000)
MIN_COUNT = int(os.getenv('RAPIDOCR_MIN_COUNT', '1') or 1)
MIN_AVG_CONF = float(os.getenv('RAPIDOCR_MIN_AVG_CONF', '0.40') or 0.40)
MIN_MAX_CONF = float(os.getenv('RAPIDOCR_MIN_MAX_CONF', '0.50') or 0.50)


def normalize_text(text):
    return str(text or '').strip()


def compact_text(text):
    import re
    return re.sub(r'\s+', '', normalize_text(text).lower())


def extract_mileage(text, min_digits=4, max_digits=6):
    import re
    normalized = normalize_text(text).replace('O', '0').replace('o', '0')
    candidates = []
    for match in re.finditer(rf'\d{{{min_digits},{max_digits}}}', normalized):
        candidates.append(match.group(0))
    for match in re.finditer(rf'(?:\d[\s.,:;\-]*){{{min_digits},{max_digits}}}', normalized):
        value = re.sub(r'\D', '', match.group(0))
        if min_digits <= len(value) <= max_digits:
            candidates.append(value)
    if not candidates:
        return None
    candidates.sort(key=lambda value: (len(value), int(value)), reverse=True)
    return int(candidates[0])


def _preprocess_gray(gray, scale=2.8, clip_limit=4.0):
    gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    denoise = cv2.fastNlMeansDenoising(gray, None, 12, 7, 21)
    adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
    return gray, adaptive


def _extract_led_channel(bgr_crop):
    hsv = cv2.cvtColor(bgr_crop, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    b, g, r = cv2.split(bgr_crop)
    brightness = np.maximum(np.maximum(r, g), b)
    _, led_mask = cv2.threshold(brightness, 100, 255, cv2.THRESH_BINARY)
    led_only = cv2.bitwise_and(v, led_mask)
    return led_only


def make_variants(image, scale=2.8, clip_limit=4.0, max_crops=4):
    height, width = image.shape[:2]
    
    resize = min(1280 / max(width, 1), 1280 / max(height, 1))
    if resize < 1.0:
        image = cv2.resize(image, None, fx=resize, fy=resize, interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]

    variants = [image]

    gray_full = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
    gray_clahe = clahe.apply(gray_full)
    denoise = cv2.fastNlMeansDenoising(gray_clahe, None, 12, 7, 21)
    adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
    variants.append(cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR))

    led_full = _extract_led_channel(image)
    if np.count_nonzero(led_full) > led_full.size * 0.01:
        _, led_adaptive = _preprocess_gray(led_full, scale=scale, clip_limit=clip_limit)
        variants.append(cv2.cvtColor(led_adaptive, cv2.COLOR_GRAY2BGR))

    crops = [
        (0.50, 0.40, 0.50, 0.55),
        (0.15, 0.50, 0.70, 0.48),
        (0.10, 0.30, 0.80, 0.40),
        (0.30, 0.35, 0.40, 0.40),
    ]
    for idx, (left_ratio, top_ratio, width_ratio, height_ratio) in enumerate(crops):
        if idx >= max_crops:
            break
        left = max(0, int(width * left_ratio))
        top = max(0, int(height * top_ratio))
        crop_width = min(width - left, int(width * width_ratio))
        crop_height = min(height - top, int(height * height_ratio))
        if crop_width <= 0 or crop_height <= 0:
            continue
        crop = image[top:top + crop_height, left:left + crop_width]
        
        crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray_crop, adaptive_crop = _preprocess_gray(crop_gray, scale=scale, clip_limit=clip_limit)
        variants.append(cv2.cvtColor(gray_crop, cv2.COLOR_GRAY2BGR))
        variants.append(cv2.cvtColor(adaptive_crop, cv2.COLOR_GRAY2BGR))

        inv_crop = 255 - crop_gray
        inv_clahe_crop = clahe.apply(inv_crop)
        inv_denoise_crop = cv2.fastNlMeansDenoising(inv_clahe_crop, None, 12, 7, 21)
        inv_adaptive_crop = cv2.adaptiveThreshold(inv_denoise_crop, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
        variants.append(cv2.cvtColor(inv_adaptive_crop, cv2.COLOR_GRAY2BGR))

        crop_led = _extract_led_channel(crop)
        if np.count_nonzero(crop_led) > crop_led.size * 0.01:
            _, crop_led_adaptive = _preprocess_gray(crop_led, scale=scale, clip_limit=clip_limit)
            variants.append(cv2.cvtColor(crop_led_adaptive, cv2.COLOR_GRAY2BGR))

    return variants


def _is_noise(text):
    low = text.lower().replace(' ', '')
    import re
    if re.search(r'\d{1,2}:\d{2}', text):
        return True
    if re.search(r'-?\d{1,2}\s*[°º]', text):
        return True
    noise = ('km/h', 'mph', 'rpm', 'x1000', '/100', 'l/100', '1/100', 'temp', 'r/m', 'kmh')
    if any(t in low for t in noise):
        return True
    if 'trip' in low and 'avg' in low:
        return True
    if 'avg' in low:
        avg_match = re.search(r'(\d{2,6})', text)
        if avg_match:
            return False
        return True
    return False


def recognize(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'mileage': None, 'error': 'image not readable'}

    pass_configs = [
        {'scale': 2.8, 'clip_limit': 4.0, 'max_crops': 2},
        {'scale': 3.5, 'clip_limit': 6.0, 'max_crops': 4},
    ]

    all_results = []
    grouped = {}

    for pass_idx, cfg in enumerate(pass_configs):
        pass_results = []
        variants = make_variants(image, scale=cfg['scale'], clip_limit=cfg['clip_limit'], max_crops=cfg['max_crops'])

        for variant in variants:
            with _engine_lock:
                ocr_result, _ = ENGINE(variant)
            if not ocr_result:
                continue
            for item in ocr_result:
                text = item[1] if len(item) > 1 else ''
                confidence = float(item[2]) if len(item) > 2 else 0
                text = str(text or '').strip()
                if not text:
                    continue
                mileage = extract_mileage(text, min_digits=2)
                if mileage:
                    has_km = 'km' in text.lower().replace(' ', '')
                    is_noise = _is_noise(text)
                    pass_results.append({'mileage': mileage, 'confidence': confidence, 'text': text, 'has_km': has_km, 'is_noise': is_noise})

        for item in pass_results:
            m = item['mileage']
            if m not in grouped:
                grouped[m] = {'mileage': m, 'count': 0, 'max_confidence': 0, 'items': [], 'has_km': False, 'is_noise': False}
            g = grouped[m]
            g['count'] += 1
            g['max_confidence'] = max(g['max_confidence'], item['confidence'])
            g['items'].append(item)
            if item['has_km']:
                g['has_km'] = True
            if item['is_noise']:
                g['is_noise'] = True

        all_results.extend(pass_results)

        non_noise_groups = [g for g in grouped.values() if not g['is_noise'] and 4 <= len(str(g['mileage'])) <= 6]
        if non_noise_groups:
            best = max(non_noise_groups, key=lambda g: (g['has_km'], g['count'], g['max_confidence']))
            best_conf = sum(it['confidence'] for it in best['items']) / max(best['count'], 1)
            if best['has_km'] and best_conf >= 0.90 and best['count'] >= 2:
                break
            if best['count'] >= 3 and best_conf >= 0.90:
                break

    for g in grouped.values():
        g['avg_confidence'] = sum(it['confidence'] for it in g['items']) / max(g['count'], 1)

    groups = sorted(grouped.values(), key=lambda g: (
        4 <= len(str(g['mileage'])) <= 6,
        g['has_km'],
        not g['is_noise'],
        len(str(g['mileage'])),
        g['count'],
        g['avg_confidence'],
    ), reverse=True)

    valid_groups = [g for g in groups if g['mileage'] >= MIN_MILEAGE and g['avg_confidence'] >= MIN_AVG_CONF and g['max_confidence'] >= MIN_MAX_CONF]
    if not valid_groups:
        valid_groups = [g for g in groups if g['mileage'] >= MIN_MILEAGE and g['max_confidence'] >= MIN_MAX_CONF]
    if not valid_groups:
        valid_groups = [g for g in groups if g['mileage'] >= MIN_MILEAGE and g['count'] >= 1]
    best = valid_groups[0] if valid_groups else None
    mileage = best['mileage'] if best else None

    return {
        'mileage': mileage,
        'selected': {
            'mileage': best['mileage'] if best else None,
            'count': best['count'] if best else 0,
            'avg_confidence': best['avg_confidence'] if best else 0,
            'max_confidence': best['max_confidence'] if best else 0,
        },
        'thresholds': {
            'min_mileage': MIN_MILEAGE,
            'min_count': MIN_COUNT,
            'min_avg_conf': MIN_AVG_CONF,
            'min_max_conf': MIN_MAX_CONF,
        },
        'groups': [
            {'mileage': g['mileage'], 'count': g['count'], 'avg_confidence': round(g['avg_confidence'], 4), 'max_confidence': round(g['max_confidence'], 4), 'has_km': g.get('has_km', False), 'is_noise': g.get('is_noise', False)}
            for g in groups if g['mileage'] >= MIN_MILEAGE
        ][:15],
    }


def make_text_variants(image):
    height, width = image.shape[:2]
    scale = min(2000 / max(width, 1), 2000 / max(height, 1), 1.0)
    if scale > 1:
        scale = min(3.0, scale)
    resized = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale != 1.0 else image
    variants = [resized]
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    denoise = cv2.fastNlMeansDenoising(gray, None, 12, 7, 21)
    variants.append(cv2.cvtColor(denoise, cv2.COLOR_GRAY2BGR))
    adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
    variants.append(cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR))
    return variants


def recognize_text(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'error': 'image not readable', 'text_items': []}

    results = []
    for variant in make_text_variants(image):
        with _engine_lock:
            ocr_output = ENGINE_TEXT(variant)
        txts = getattr(ocr_output, 'txts', None) or []
        scores = getattr(ocr_output, 'scores', None) or []
        for i, text in enumerate(txts):
            confidence = float(scores[i]) if i < len(scores) else 0
            if text and text.strip():
                results.append({'text': text, 'confidence': confidence})

    seen = set()
    unique = []
    for item in results:
        key = item['text'].strip().lower()
        if key not in seen:
            seen.add(key)
            unique.append(item)

    return {'text_items': unique}


class RapidOcrHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length <= 0 or content_length > 20 * 1024 * 1024:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'mileage': None, 'error': 'invalid content length'}).encode())
            return

        body = self.rfile.read(content_length)
        try:
            if self.path == '/text':
                result = recognize_text(body)
            else:
                result = recognize(body)
        except Exception as e:
            result = {'mileage': None, 'error': str(e)}
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
            self.wfile.write(b'{"status":"ok"}')
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
        print(f'RapidOCR server listening on 127.0.0.1:{port}', flush=True)
        server.serve_forever()
    elif len(sys.argv) >= 2:
        image_path = sys.argv[1]
        image = cv2.imread(image_path)
        if image is None:
            print(json.dumps({'mileage': None, 'error': 'image not readable'}))
            return
        _, buf = cv2.imencode('.jpg', image)
        result = recognize(buf.tobytes())
        print(json.dumps(result, ensure_ascii=True))
    else:
        print(json.dumps({'mileage': None, 'error': 'usage: rapidocr_server.py [--server] [image_path]'}))


if __name__ == '__main__':
    main()