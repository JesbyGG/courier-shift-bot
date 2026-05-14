import json
import os
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ENGINE = RapidOCR()

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
MIN_AVG_CONF = float(os.getenv('RAPIDOCR_MIN_AVG_CONF', '0.55') or 0.55)
MIN_MAX_CONF = float(os.getenv('RAPIDOCR_MIN_MAX_CONF', '0.68') or 0.68)


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


def make_variants(image):
    height, width = image.shape[:2]
    
    # Scale down extremely large images (e.g. 4000x3000) so that the 2.8x crop multiplier
    # doesn't create a 6000px image, which causes timeouts and poor denoising.
    # We cap the base image at ~1280px. This leaves the standard denoising logic perfectly intact.
    scale = min(1280 / max(width, 1), 1280 / max(height, 1))
    if scale < 1.0:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]

    variants = [image]
    crops = [
        (0.50, 0.40, 0.50, 0.55), # bottom right
        (0.15, 0.50, 0.70, 0.48), # bottom wide
        (0.30, 0.35, 0.40, 0.40), # center
        (0.20, 0.10, 0.60, 0.40), # top center
        (0.10, 0.30, 0.80, 0.40), # middle wide
        (0.40, 0.15, 0.50, 0.40), # top right
    ]
    for left_ratio, top_ratio, width_ratio, height_ratio in crops:
        left = max(0, int(width * left_ratio))
        top = max(0, int(height * top_ratio))
        crop_width = min(width - left, int(width * width_ratio))
        crop_height = min(height - top, int(height * height_ratio))
        if crop_width <= 0 or crop_height <= 0:
            continue
        crop = image[top:top + crop_height, left:left + crop_width]
        
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, None, fx=2.8, fy=2.8, interpolation=cv2.INTER_CUBIC)
        gray = cv2.equalizeHist(gray)
        denoise = cv2.fastNlMeansDenoising(gray, None, 12, 7, 21)
        adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
        variants.append(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
        variants.append(cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR))
    return variants


def is_prefix_of(longer, shorter):
    return str(longer).startswith(str(shorter)) and len(str(longer)) == len(str(shorter)) + 1


def generate_lcd_candidates(mileage):
    s = str(mileage)
    if s.endswith('0'):
        return [mileage, mileage + 1]
    return [mileage]


def generate_extensions(mileage, max_digits=6):
    s = str(mileage)
    extensions = []
    if len(s) >= max_digits:
        return extensions
    for d in range(10):
        ext = mileage * 10 + d
        extensions.append(ext)
    return extensions


def resolve_prefix_conflicts(groups):
    if len(groups) <= 1:
        return groups

    merged = {}
    for group in groups:
        mileage = group['mileage']
        merged[mileage] = group.copy()

    mileages = sorted(merged.keys())
    prefix_pairs = []
    for i, longer in enumerate(mileages):
        for j, shorter in enumerate(mileages):
            if i == j:
                continue
            if is_prefix_of(longer, shorter):
                prefix_pairs.append((longer, shorter))
            elif str(longer).startswith(str(shorter)) and len(str(longer)) == len(str(shorter)) + 1:
                prefix_pairs.append((longer, shorter))

    for longer, shorter in prefix_pairs:
        if shorter not in merged or longer not in merged:
            continue
        longer_str = str(longer)
        shorter_str = str(shorter)

        if longer_str.endswith('0') and shorter_str == longer_str[:-1]:
            for alt in generate_lcd_candidates(longer):
                if alt != longer:
                    if alt in merged:
                        merged[alt]['count'] += merged[longer]['count']
                        merged[alt]['items'].extend(merged[longer]['items'])
                        merged[alt]['avg_confidence'] = sum(
                            item['confidence'] for item in merged[alt]['items']
                        ) / max(merged[alt]['count'], 1)
                        merged[alt]['max_confidence'] = max(
                            merged[alt]['max_confidence'], merged[longer]['max_confidence']
                        )
                        del merged[shorter]
                        del merged[longer]
                    else:
                        alt_group = merged[longer].copy()
                        alt_group['mileage'] = alt
                        alt_group['count'] = merged[longer]['count']
                        alt_group['avg_confidence'] = merged[longer]['avg_confidence'] * 0.85
                        alt_group['max_confidence'] = merged[longer]['max_confidence'] * 0.85
                        alt_group['lcd_alternative'] = True
                        alt_group['items'] = [
                            {**item, 'mileage': alt, 'confidence': item['confidence'] * 0.85, 'lcd_alternative': True}
                            for item in merged[longer]['items']
                        ]
                        merged[alt] = alt_group
                        del merged[shorter]
                        del merged[longer]
                    break
            continue

        if merged[longer]['avg_confidence'] >= 0.50:
            if shorter in merged and longer in merged:
                merged[longer]['count'] += merged[shorter]['count']
                merged[longer]['items'].extend(merged[shorter]['items'])
                merged[longer]['avg_confidence'] = sum(
                    item['confidence'] for item in merged[longer]['items']
                ) / max(merged[longer]['count'], 1)
                merged[longer]['max_confidence'] = max(
                    merged[longer]['max_confidence'], merged[shorter]['max_confidence']
                )
                del merged[shorter]

    result = sorted(merged.values(), key=lambda item: (
        item.get('region_weight', item['count']),
        item['count'],
        item['avg_confidence'],
        len(str(item['mileage']))
    ), reverse=True)
    return result


def recognize(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'mileage': None, 'error': 'image not readable'}

    results = []
    for variant in make_variants(image):
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
                results.append({'mileage': mileage, 'confidence': confidence, 'text': text})

    grouped = {}
    for item in results:
        mileage = item['mileage']
        group = grouped.setdefault(mileage, {'mileage': mileage, 'count': 0, 'max_confidence': 0, 'avg_confidence': 0, 'items': [], 'region_weight': 0})
        group['count'] += 1
        group['region_weight'] += 1
        group['max_confidence'] = max(group['max_confidence'], item['confidence'])
        group['items'].append(item)
    for group in grouped.values():
        group['avg_confidence'] = sum(item['confidence'] for item in group['items']) / max(group['count'], 1)

    groups = sorted(grouped.values(), key=lambda item: (item['count'], item['avg_confidence'], len(str(item['mileage']))), reverse=True)

    prefix_groups = resolve_prefix_conflicts(groups)

    short_mileages = {g['mileage'] for g in prefix_groups if len(str(g['mileage'])) < 6}
    long_mileages = {g['mileage'] for g in prefix_groups}
    for short in short_mileages:
        if short not in grouped:
            continue
        has_longer = any(long for long in long_mileages if str(long).startswith(str(short)) and long != short)
        if not has_longer:
            for ext in generate_extensions(short):
                if ext not in grouped:
                    grouped[ext] = {
                        'mileage': ext,
                        'count': 0,
                        'max_confidence': grouped[short]['max_confidence'] * 0.50,
                        'avg_confidence': grouped[short]['avg_confidence'] * 0.50,
                        'items': [],
                        'region_weight': 0,
                        'extension_of': short,
                    }
            long_mileages.update(generate_extensions(short))

    if len(grouped) > len(prefix_groups):
        groups = sorted(grouped.values(), key=lambda item: (item.get('region_weight', item['count']), item['count'], item['avg_confidence'], len(str(item['mileage']))), reverse=True)
        prefix_groups = resolve_prefix_conflicts(groups)

    valid_groups = [g for g in prefix_groups if g['mileage'] >= MIN_MILEAGE and g['count'] >= MIN_COUNT and g['avg_confidence'] >= MIN_AVG_CONF and g['max_confidence'] >= MIN_MAX_CONF]
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
            {'mileage': g['mileage'], 'count': g['count'], 'avg_confidence': g['avg_confidence'], 'max_confidence': g['max_confidence']}
            for g in prefix_groups if g['count'] >= 1 and g['avg_confidence'] >= 0.35 and g['mileage'] >= MIN_MILEAGE
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
        self.wfile.write(response)

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


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == '--server':
        port = int(os.getenv('RAPIDOCR_PORT', '9527') or 9527)
        server = HTTPServer(('127.0.0.1', port), RapidOcrHandler)
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