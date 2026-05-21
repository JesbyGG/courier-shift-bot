import json
import sys
import os
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

ENGINE = RapidOCR()

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

def full_debug(image_path):
    image = cv2.imread(image_path)
    _, buf = cv2.imencode('.jpg', image)
    image_bytes = buf.tobytes()

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
        'best': best,
        'valid_groups_count': len(valid_groups),
        'prefix_groups': [{k: g[k] for k in ['mileage','count','avg_confidence','max_confidence']} for g in prefix_groups],
        'thresholds': {'min_mileage': MIN_MILEAGE, 'min_count': MIN_COUNT, 'min_avg_conf': MIN_AVG_CONF, 'min_max_conf': MIN_MAX_CONF}
    }

if __name__ == '__main__':
    result = full_debug(sys.argv[1])
    print(json.dumps(result, ensure_ascii=True, indent=2))
