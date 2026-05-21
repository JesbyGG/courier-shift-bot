#!/usr/bin/env python3
import json, sys, os, subprocess
sys.path.insert(0, '/root/courier-shift-bot')
os.chdir('/root/courier-shift-bot')

from rapidocr_onnxruntime import RapidOCR
import cv2
import numpy as np

ENGINE = RapidOCR()

MIN_MILEAGE = 1000

def normalize_text(text):
    return str(text or '').strip()

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
    scale = min(1280 / max(width, 1), 1280 / max(height, 1))
    if scale < 1.0:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]
    variants = [image]
    crops = [
        (0.50, 0.40, 0.50, 0.55),
        (0.15, 0.50, 0.70, 0.48),
        (0.30, 0.35, 0.40, 0.40),
        (0.20, 0.10, 0.60, 0.40),
        (0.10, 0.30, 0.80, 0.40),
        (0.40, 0.15, 0.50, 0.40),
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

import glob
files = sorted(glob.glob('/root/courier-shift-bot/test_photos/*.jpg'))

for fpath in files:
    fname = os.path.basename(fpath)
    image = cv2.imread(fpath)
    if image is None:
        print(f"{fname} => ERROR")
        continue
    _, buf = cv2.imencode('.jpg', image)
    image_bytes = buf.tobytes()

    nparr = np.frombuffer(image_bytes, np.uint8)
    image2 = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    results = []
    for variant in make_variants(image2):
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
                results.append({'mileage': mileage, 'confidence': confidence, 'text': text, 'has_km': has_km})

    if not results:
        print(f"{fname} => NULL (no OCR)")
        continue

    grouped = {}
    for item in results:
        m = item['mileage']
        if m not in grouped:
            grouped[m] = {'mileage': m, 'count': 0, 'max_confidence': 0, 'avg_confidence': 0, 'items': [], 'has_km': False}
        g = grouped[m]
        g['count'] += 1
        g['max_confidence'] = max(g['max_confidence'], item['confidence'])
        g['items'].append(item)
        if item['has_km']:
            g['has_km'] = True
    for g in grouped.values():
        g['avg_confidence'] = sum(it['confidence'] for it in g['items']) / max(g['count'], 1)

    all_mileages = sorted(grouped.keys())
    to_delete = set()
    for m in all_mileages:
        if m in to_delete or m not in grouped:
            continue
        s = str(m)
        for other_m in all_mileages:
            if other_m == m or other_m in to_delete or other_m not in grouped:
                continue
            o = str(other_m)
            if o.startswith(s) and len(o) > len(s):
                grouped[other_m]['count'] += grouped[m]['count']
                grouped[other_m]['items'].extend(grouped[m]['items'])
                grouped[other_m]['avg_confidence'] = sum(it['confidence'] for it in grouped[other_m]['items']) / max(grouped[other_m]['count'], 1)
                grouped[other_m]['max_confidence'] = max(grouped[other_m]['max_confidence'], grouped[m]['max_confidence'])
                if grouped[m]['has_km']:
                    grouped[other_m]['has_km'] = True
                to_delete.add(m)
                break

    for m in to_delete:
        del grouped[m]

    groups = sorted(grouped.values(), key=lambda g: (
        5 <= len(str(g['mileage'])) <= 7,
        g['has_km'],
        g['count'],
        g['avg_confidence'],
    ), reverse=True)

    valid = [g for g in groups if g['mileage'] >= MIN_MILEAGE and g['count'] >= 1 and g['avg_confidence'] >= 0.55 and g['max_confidence'] >= 0.68]
    best = valid[0] if valid else None
    mileage = best['mileage'] if best else None

    top3 = [(g['mileage'], g['count'], round(g['avg_confidence'], 2), g['has_km']) for g in groups[:3]]
    print(f"{fname} => {mileage}  top3={top3}")