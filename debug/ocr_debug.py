#!/usr/bin/env python3
"""
Unified OCR debug tool.

Usage:
  python debug/ocr_debug.py photo.jpg                    # basic debug
  python debug/ocr_debug.py --mode diagnose photo.jpg    # diagnose mode
  python debug/ocr_debug.py --mode full photo.jpg        # full debug with prefix resolution

Run from project root:
  python debug/ocr_debug.py test_photos/photo.jpg
"""

import json
import sys
import os
import argparse
import re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

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
    return re.sub(r'\s+', '', normalize_text(text).lower())


def extract_mileage(text, min_digits=4, max_digits=6):
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
    candidates.sort(key=lambda v: (len(v), int(v)), reverse=True)
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
    low = compact_text(text)
    if not low:
        return True
    if re.search(r'\b\d{1,2}:\d{2}\b', text):
        return True
    if re.search(r'-?\d{1,2}\s*[°º]', text):
        return True
    noise_tokens = ['km/h', 'mph', 'rpm', 'x1000', '/100', 'l/100', '1/100', 'trip', 'avg', 'temp', 'r/m', 'kmh']
    return any(t in low for t in noise_tokens)


def recognize_basic(image_bytes):
    """Basic debug: groups, thresholds, best candidate."""
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'mileage': None, 'error': 'image not readable'}

    pass_configs = [
        {'scale': 2.8, 'clip_limit': 4.0, 'max_crops': 2},
        {'scale': 3.5, 'clip_limit': 6.0, 'max_crops': 4},
    ]

    grouped = {}

    for pass_idx, cfg in enumerate(pass_configs):
        for variant in make_variants(image, scale=cfg['scale'], clip_limit=cfg['clip_limit'], max_crops=cfg['max_crops']):
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
                has_km = 'km' in text.lower().replace(' ', '')
                is_noise = _is_noise(text)
                if mileage:
                    if mileage not in grouped:
                        grouped[mileage] = {'mileage': mileage, 'count': 0, 'max_confidence': 0, 'items': [], 'has_km': False, 'is_noise': False}
                    g = grouped[mileage]
                    g['count'] += 1
                    g['max_confidence'] = max(g['max_confidence'], confidence)
                    g['items'].append({'text': text, 'confidence': confidence, 'mileage': mileage, 'has_km': has_km, 'pass': pass_idx})
                    if has_km:
                        g['has_km'] = True
                    if is_noise:
                        g['is_noise'] = True

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

    valid_groups = [g for g in groups if g['mileage'] >= MIN_MILEAGE and g['count'] >= MIN_COUNT and g['avg_confidence'] >= MIN_AVG_CONF and g['max_confidence'] >= MIN_MAX_CONF]
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
            {k: g[k] for k in ('mileage', 'count', 'avg_confidence', 'max_confidence', 'has_km', 'is_noise')}
            for g in groups if g['mileage'] >= MIN_MILEAGE
        ][:15],
    }


def recognize_diagnose(image_bytes):
    """Diagnose mode: all raw OCR texts per variant."""
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'error': 'image not readable'}

    all_texts = []
    for i, variant in enumerate(make_variants(image)):
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
            all_texts.append({'variant': i, 'text': text, 'confidence': confidence, 'mileage': mileage})

    by_mileage = {}
    for item in all_texts:
        m = item['mileage']
        if m:
            by_mileage.setdefault(m, []).append(item)

    return {'file': '<bytes>', 'all_texts': all_texts, 'by_mileage': {str(k): v for k, v in by_mileage.items()}}


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
            if str(longer).startswith(str(shorter)) and len(str(longer)) == len(str(shorter)) + 1:
                prefix_pairs.append((longer, shorter))

    for longer, shorter in prefix_pairs:
        if shorter not in merged or longer not in merged:
            continue
        longer_str = str(longer)

        if longer_str.endswith('0') and str(shorter) == longer_str[:-1]:
            for alt in [longer, longer + 1]:
                if alt in merged and alt != longer:
                    merged[alt]['count'] += merged[longer]['count']
                    merged[alt]['items'].extend(merged[longer]['items'])
                    merged[alt]['avg_confidence'] = sum(it['confidence'] for it in merged[alt]['items']) / max(merged[alt]['count'], 1)
                    merged[alt]['max_confidence'] = max(merged[alt]['max_confidence'], merged[longer]['max_confidence'])
                    del merged[shorter]
                    del merged[longer]
                    break
            continue

        if merged[longer]['avg_confidence'] >= 0.50:
            if shorter in merged and longer in merged:
                merged[longer]['count'] += merged[shorter]['count']
                merged[longer]['items'].extend(merged[shorter]['items'])
                merged[longer]['avg_confidence'] = sum(it['confidence'] for it in merged[longer]['items']) / max(merged[longer]['count'], 1)
                merged[longer]['max_confidence'] = max(merged[longer]['max_confidence'], merged[shorter]['max_confidence'])
                del merged[shorter]

    return sorted(merged.values(), key=lambda item: (item.get('region_weight', item['count']), item['count'], item['avg_confidence'], len(str(item['mileage']))), reverse=True)


def recognize_full(image_bytes):
    """Full debug: prefix conflict resolution, LCD candidates, extensions."""
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'error': 'image not readable'}

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
        group['avg_confidence'] = sum(it['confidence'] for it in group['items']) / max(group['count'], 1)

    groups = sorted(grouped.values(), key=lambda item: (item['count'], item['avg_confidence'], len(str(item['mileage']))), reverse=True)
    prefix_groups = resolve_prefix_conflicts(groups)

    valid_groups = [g for g in prefix_groups if g['mileage'] >= MIN_MILEAGE and g['count'] >= MIN_COUNT and g['avg_confidence'] >= MIN_AVG_CONF and g['max_confidence'] >= MIN_MAX_CONF]
    best = valid_groups[0] if valid_groups else None
    mileage = best['mileage'] if best else None

    return {
        'mileage': mileage,
        'best': best,
        'valid_groups_count': len(valid_groups),
        'prefix_groups': [{k: g[k] for k in ('mileage', 'count', 'avg_confidence', 'max_confidence')} for g in prefix_groups],
        'thresholds': {'min_mileage': MIN_MILEAGE, 'min_count': MIN_COUNT, 'min_avg_conf': MIN_AVG_CONF, 'min_max_conf': MIN_MAX_CONF},
    }


def main():
    parser = argparse.ArgumentParser(description='OCR debug tool')
    parser.add_argument('image', help='Path to image file')
    parser.add_argument('--mode', choices=['basic', 'diagnose', 'full'], default='basic',
                        help='Debug mode: basic (default), diagnose, or full')
    args = parser.parse_args()

    image = cv2.imread(args.image)
    if image is None:
        print(json.dumps({'error': f'cannot read image: {args.image}'}, ensure_ascii=True))
        sys.exit(1)

    _, buf = cv2.imencode('.jpg', image)
    image_bytes = buf.tobytes()

    if args.mode == 'diagnose':
        result = recognize_diagnose(image_bytes)
    elif args.mode == 'full':
        result = recognize_full(image_bytes)
    else:
        result = recognize_basic(image_bytes)

    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()