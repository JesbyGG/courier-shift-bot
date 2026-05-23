import json
import os
import re
import sys
import threading
import time
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

MIN_MILEAGE = int(os.getenv('OCR_MIN_MILEAGE', '100') or 100)
MIN_COUNT = int(os.getenv('RAPIDOCR_MIN_COUNT', '1') or 1)
MIN_AVG_CONF = float(os.getenv('RAPIDOCR_MIN_AVG_CONF', '0.40') or 0.40)
MIN_MAX_CONF = float(os.getenv('RAPIDOCR_MIN_MAX_CONF', '0.50') or 0.50)

SPEED_SCALE_NUMBERS = set(range(20, 280, 20))

_KM_VARIANTS = ('km', '/km', 'ikm', 'lkm', 'xkm', '\\km', 'cm', '／km', '／m', '/m')


def _has_km_marker(text):
    low = text.lower().replace(' ', '').replace('\u200b', '')
    for marker in _KM_VARIANTS:
        if marker in low:
            return True
    return False


def normalize_text(text):
    return str(text or '').strip()


def compact_text(text):
    return re.sub(r'\s+', '', normalize_text(text).lower())


def extract_mileage(text, min_digits=3, max_digits=6):
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


def _is_speed_scale_number(num):
    if num in SPEED_SCALE_NUMBERS:
        return True
    for divisor in (10, 100, 1000):
        prefix = num // divisor
        remainder = num % divisor
        if prefix in SPEED_SCALE_NUMBERS and remainder in SPEED_SCALE_NUMBERS:
            return True
    return False


def _is_noise(text):
    low = text.lower().replace(' ', '')
    if re.search(r'\d{1,2}:\d{2}', text):
        return True
    if re.search(r'-?\d{1,2}\s*[°º]', text):
        return True
    noise = ('km/h', 'mph', 'rpm', 'x1000', 'x1000r/min', 'x1000r', '/100', 'l/100', '1/100', 'temp', 'r/m', 'kmh', '%')
    if any(t in low for t in noise):
        return True
    if 'trip' in low and 'avg' in low:
        return True
    if 'avg' in low:
        if re.search(r'\d{2,6}', text):
            return False
        return True
    digits = re.sub(r'\D', '', text)
    if digits and len(digits) <= 6:
        num = int(digits)
        if _is_speed_scale_number(num):
            return True
    has_km = _has_km_marker(text)
    if has_km and digits and len(digits) <= 7:
        num = int(digits)
        stripped = _try_strip_leading_digit(num, has_km) if len(digits) >= 7 else num
        if _is_speed_scale_number(stripped if len(str(stripped)) <= 6 else num):
            return True
    return False


def _try_strip_leading_digit(mileage, has_km):
    s = str(mileage)
    if len(s) < 7:
        return mileage
    candidates = []
    for offset in range(1, min(3, len(s) - 4)):
        stripped = int(s[offset:])
        if 1000 <= stripped <= 999999:
            candidates.append(stripped)
    stripped5 = int(s[-5:])
    stripped6 = int(s[-6:])
    if 10000 <= stripped5 <= 99999:
        candidates.append(stripped5)
    if 100000 <= stripped6 <= 999999:
        candidates.append(stripped6)
    if not candidates:
        return mileage
    candidates.sort(key=lambda x: (5 <= len(str(x)) <= 6, x), reverse=True)
    return candidates[0]


def _preprocess_gray(gray, scale=2.8, clip_limit=4.0):
    gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    # speed: lighter denoise vs full NLM
    denoise = cv2.fastNlMeansDenoising(gray, None, 8, 5, 15)
    adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
    return gray, adaptive


def _extract_led_channel(bgr_crop, threshold=60):
    hsv = cv2.cvtColor(bgr_crop, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    b, g, r = cv2.split(bgr_crop)
    brightness = np.maximum(np.maximum(r, g), b)
    _, led_mask = cv2.threshold(brightness, threshold, 255, cv2.THRESH_BINARY)
    led_only = cv2.bitwise_and(v, led_mask)
    return led_only


def _make_phase1_variants(image):
    height, width = image.shape[:2]
    resize = min(1920 / max(width, 1), 1920 / max(height, 1))
    if resize < 1.0:
        image = cv2.resize(image, None, fx=resize, fy=resize, interpolation=cv2.INTER_AREA)

    variants = [image]

    gray_full = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8))
    gray_clahe = clahe.apply(gray_full)
    denoise = cv2.fastNlMeansDenoising(gray_clahe, None, 8, 5, 15)
    adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
    variants.append(cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR))

    # standard LED (bright digits)
    led_full = _extract_led_channel(image, threshold=60)
    if np.count_nonzero(led_full) > led_full.size * 0.005:
        _, led_adaptive = _preprocess_gray(led_full, scale=2.8, clip_limit=4.0)
        variants.append(cv2.cvtColor(led_adaptive, cv2.COLOR_GRAY2BGR))

    # low-threshold LED for tiny "km" text
    led_low = _extract_led_channel(image, threshold=35)
    if np.count_nonzero(led_low) > led_low.size * 0.003:
        _, led_low_adaptive = _preprocess_gray(led_low, scale=2.8, clip_limit=4.0)
        variants.append(cv2.cvtColor(led_low_adaptive, cv2.COLOR_GRAY2BGR))

    return variants


def _make_phase3_variants(image):
    height, width = image.shape[:2]
    resize = min(1920 / max(width, 1), 1920 / max(height, 1))
    if resize < 1.0:
        image = cv2.resize(image, None, fx=resize, fy=resize, interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]

    variants = []
    crop_y_offsets = []

    # One aggressive full-width lower crop
    left = 0
    top = int(height * 0.55)
    crop_w = width
    crop_h = min(height - top, int(height * 0.45))
    if crop_h > 0:
        crop = image[top:top + crop_h, left:left + crop_w]

        crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray_crop, adaptive_crop = _preprocess_gray(crop_gray, scale=3.0, clip_limit=6.0)
        variants.append(cv2.cvtColor(adaptive_crop, cv2.COLOR_GRAY2BGR))
        crop_y_offsets.append(0.55)

        for threshold in (40, 75):
            crop_led = _extract_led_channel(crop, threshold=threshold)
            if np.count_nonzero(crop_led) > crop_led.size * 0.003:
                _, led_adaptive = _preprocess_gray(crop_led, scale=3.0, clip_limit=6.0)
                variants.append(cv2.cvtColor(led_adaptive, cv2.COLOR_GRAY2BGR))
                crop_y_offsets.append(0.55)

    return variants, crop_y_offsets


def _make_phase2_variants(image):
    height, width = image.shape[:2]
    resize = min(1920 / max(width, 1), 1920 / max(height, 1))
    if resize < 1.0:
        image = cv2.resize(image, None, fx=resize, fy=resize, interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]

    variants = []
    crop_y_offsets = []

    # Only 2 crops: full-width lower + central region
    crops = [
        (0.0, 0.45, 1.0, 0.55),   # full width, lower half
        (0.15, 0.35, 0.70, 0.50), # central region
    ]
    for left_ratio, top_ratio, width_ratio, height_ratio in crops:
        left = max(0, int(width * left_ratio))
        top = max(0, int(height * top_ratio))
        crop_width = min(width - left, int(width * width_ratio))
        crop_height = min(height - top, int(height * height_ratio))
        if crop_width <= 0 or crop_height <= 0:
            continue
        crop = image[top:top + crop_height, left:left + crop_width]

        crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray_crop, adaptive_crop = _preprocess_gray(crop_gray, scale=2.5, clip_limit=5.0)
        variants.append(cv2.cvtColor(gray_crop, cv2.COLOR_GRAY2BGR))
        crop_y_offsets.append(top_ratio)
        variants.append(cv2.cvtColor(adaptive_crop, cv2.COLOR_GRAY2BGR))
        crop_y_offsets.append(top_ratio)

        crop_led = _extract_led_channel(crop, threshold=60)
        if np.count_nonzero(crop_led) > crop_led.size * 0.005:
            _, crop_led_adaptive = _preprocess_gray(crop_led, scale=2.5, clip_limit=5.0)
            variants.append(cv2.cvtColor(crop_led_adaptive, cv2.COLOR_GRAY2BGR))
            crop_y_offsets.append(top_ratio)

    # One full-image adaptive at moderate scale
    gray_scaled, adaptive_scaled = _preprocess_gray(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), scale=2.2, clip_limit=5.0)
    variants.append(cv2.cvtColor(adaptive_scaled, cv2.COLOR_GRAY2BGR))
    crop_y_offsets.append(0.0)

    return variants, crop_y_offsets


def _bbox_center(bbox):
    if bbox is None or len(bbox) < 4:
        return None
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)


def _bbox_dims(bbox):
    if bbox is None or len(bbox) < 4:
        return None, None
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    return width, height


def _merge_nearby_fragments(results):
    if len(results) <= 1:
        return results

    items = []
    for r in results:
        bbox = r.get('bbox')
        if bbox is None:
            items.append(r)
            continue
        center = _bbox_center(bbox)
        w, h = _bbox_dims(bbox)
        if center is None or w is None:
            items.append(r)
            continue
        items.append(r)

    if len(items) <= 1:
        return items

    digit_indices = set()
    for i, item in enumerate(items):
        if item.get('bbox') and re.search(r'\d', item['text']):
            digit_indices.add(i)

    if not digit_indices:
        return items

    groups = [[i] for i in range(len(items))]
    parent = list(range(len(items)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    sorted_items = sorted(range(len(items)), key=lambda i: _bbox_center(items[i].get('bbox'))[0] if items[i].get('bbox') else 0)

    for idx_a in range(len(sorted_items)):
        i = sorted_items[idx_a]
        if items[i].get('bbox') is None:
            continue
        ci = _bbox_center(items[i]['bbox'])
        wi, hi = _bbox_dims(items[i]['bbox'])

        for idx_b in range(idx_a + 1, len(sorted_items)):
            j = sorted_items[idx_b]
            if items[j].get('bbox') is None:
                continue
            cj = _bbox_center(items[j]['bbox'])
            wj, hj = _bbox_dims(items[j]['bbox'])

            x_gap = cj[0] - ci[0]
            if x_gap > max(wi, wj) * 2.0:
                break

            y_diff = abs(ci[1] - cj[1])
            avg_h = max(hi, hj, 1)
            if y_diff > avg_h * 0.5:
                continue

            gap_threshold = max(avg_h * 0.8, 20)
            if x_gap < gap_threshold:
                union(i, j)

    merged_results = []
    group_ids = {}
    for i in range(len(items)):
        root = find(i)
        if root not in group_ids:
            group_ids[root] = []
        group_ids[root].append(i)

    for root, members in group_ids.items():
        if len(members) == 1:
            merged_results.append(items[members[0]])
            continue

        has_digit = any(re.search(r'\d', items[m]['text']) for m in members)
        if not has_digit:
            for m in members:
                merged_results.append(items[m])
            continue

        members_sorted = sorted(members, key=lambda m: _bbox_center(items[m]['bbox'])[0] if items[m].get('bbox') else 0)
        combined_text = ' '.join(items[m]['text'] for m in members_sorted)
        combined_conf = sum(items[m]['confidence'] for m in members_sorted) / len(members_sorted)

        merged_results.append({
            'text': combined_text,
            'confidence': combined_conf,
            'bbox': None,
            'merged_from': [items[m]['text'] for m in members_sorted],
        })

    return merged_results


def _ocr_variants(variants, image_height=None, crop_y_offsets=None):
    results = []
    crop_y_offsets = crop_y_offsets or []
    for variant_idx, variant in enumerate(variants):
        variant_h = variant.shape[0] if hasattr(variant, 'shape') else None
        crop_y_ratio = crop_y_offsets[variant_idx] if variant_idx < len(crop_y_offsets) else 0.0
        with _engine_lock:
            ocr_result, _ = ENGINE(variant)
        if not ocr_result:
            continue
        for item in ocr_result:
            text = str(item[1] if len(item) > 1 else '').strip()
            confidence = float(item[2]) if len(item) > 2 else 0
            if not text:
                continue
            bbox = item[0] if len(item) > 0 else None
            y_ratio = None
            if bbox and variant_h and image_height:
                cy = (min(p[1] for p in bbox) + max(p[1] for p in bbox)) / 2
                real_y = cy / variant_h + crop_y_ratio
                y_ratio = real_y
            results.append({'text': text, 'confidence': confidence, 'bbox': bbox, 'y_ratio': y_ratio})

    seen = set()
    unique = []
    for r in results:
        key = r['text'].strip().lower()
        if key not in seen:
            seen.add(key)
            unique.append(r)
    return unique


def _process_ocr_results(results, options=None):
    options = options or {}
    min_mileage = options.get('min_mileage', MIN_MILEAGE)
    max_mileage = options.get('max_mileage', None)

    grouped = {}
    for item in results:
        text = item['text']
        confidence = item['confidence']
        y_ratio = item.get('y_ratio')

        has_km = _has_km_marker(text)
        is_noise = _is_noise(text)
        is_upper = y_ratio is not None and y_ratio < 0.45 and not has_km

        mileage = extract_mileage(text, min_digits=3)
        if mileage is None and has_km:
            km_match = re.search(r'(\d[\d\s.,]*)\s*(?:km|ikm|lkm|xkm|/km|/m|cm|／m)', text.lower().replace(' ', ''))
            if km_match:
                digit_str = re.sub(r'\D', '', km_match.group(1))
                if 3 <= len(digit_str) <= 7:
                    mileage = int(digit_str)
                    if len(digit_str) >= 7:
                        stripped = _try_strip_leading_digit(mileage, True)
                        if stripped != mileage:
                            mileage = stripped

        if mileage is None and item.get('merged_from'):
            merged_digits = re.sub(r'\D', '', ''.join(item['merged_from']))
            merged_km = ''.join(item['merged_from']).lower().replace(' ', '')
            if 3 <= len(merged_digits) <= 6:
                mileage = int(merged_digits)
                if _has_km_marker(merged_km):
                    has_km = True
            elif len(merged_digits) >= 7:
                stripped = _try_strip_leading_digit(int(merged_digits), _has_km_marker(merged_km))
                if 3 <= len(str(stripped)) <= 6:
                    mileage = stripped
                    if _has_km_marker(merged_km):
                        has_km = True

        if mileage is None:
            continue

        if mileage >= 1000000:
            continue

        if has_km and len(str(mileage)) >= 7:
            stripped = _try_strip_leading_digit(mileage, True)
            if stripped != mileage and 3 <= len(str(stripped)) <= 6:
                mileage_stripped = stripped
            else:
                mileage_stripped = None
        else:
            mileage_stripped = None

        for m in ([mileage] + ([mileage_stripped] if mileage_stripped and mileage_stripped != mileage else [])):
            if m < 100:
                continue
            if m not in grouped:
                grouped[m] = {'mileage': m, 'count': 0, 'max_confidence': 0, 'items': [], 'has_km': False, 'is_noise': False, 'is_upper': False}
            g = grouped[m]
            g['count'] += 1
            g['max_confidence'] = max(g['max_confidence'], confidence)
            g['items'].append({'text': text, 'confidence': confidence})
            if has_km:
                g['has_km'] = True
            if is_noise:
                g['is_noise'] = True
            if is_upper:
                g['is_upper'] = True

    for g in grouped.values():
        g['avg_confidence'] = sum(it['confidence'] for it in g['items']) / max(g['count'], 1)

    km_groups = [g for g in grouped.values() if g['has_km'] and not g['is_noise'] and g['mileage'] >= min_mileage]
    km_groups.sort(key=lambda g: (not g.get('is_upper'), len(str(g['mileage'])), g['count'], g['avg_confidence']), reverse=True)

    non_noise_groups = [g for g in grouped.values() if not g['is_noise'] and g['mileage'] >= min_mileage and len(str(g['mileage'])) >= 5]
    non_noise_groups.sort(key=lambda g: (not g.get('is_upper'), g['count'], g['avg_confidence']), reverse=True)

    all_sorted = sorted(grouped.values(), key=lambda g: (
        g['has_km'],
        not g['is_noise'],
        not g.get('is_upper'),
        len(str(g['mileage'])) >= 5,
        g['count'],
        g['avg_confidence'],
    ), reverse=True)

    best = None
    if km_groups:
        best = km_groups[0]
    elif non_noise_groups:
        best = non_noise_groups[0]

    return best, grouped, all_sorted


def _check_phase1_done(grouped):
    km_groups = [g for g in grouped.values() if g['has_km'] and not g['is_noise'] and g['mileage'] >= MIN_MILEAGE and g['avg_confidence'] >= 0.50]
    if km_groups:
        best = max(km_groups, key=lambda g: (len(str(g['mileage'])) >= 5, g['count'], g['avg_confidence']))
        if best['count'] >= 1:
            return True
    long_groups = [g for g in grouped.values() if not g['is_noise'] and g['mileage'] >= MIN_MILEAGE and len(str(g['mileage'])) >= 5 and g['avg_confidence'] >= 0.60 and g['count'] >= 2]
    if long_groups:
        return True
    return False


def _merge_fragments_smart(results):
    digit_items = []
    km_items = []
    other_items = []
    for r in results:
        has_digit = bool(re.search(r'\d{4,}', r['text']))
        has_km_marker = _has_km_marker(r['text'])
        if has_km_marker and not has_digit:
            km_items.append(r)
        elif has_digit and not has_km_marker:
            digit_items.append(r)
        else:
            other_items.append(r)

    if not km_items or not digit_items:
        return results

    merged = list(other_items)
    used_km = set()

    for d in digit_items:
        d_bbox = d.get('bbox')
        if d_bbox is None or len(d_bbox) < 4:
            merged.append(d)
            continue
        d_cx, d_cy = _bbox_center(d_bbox)
        d_w, d_h = _bbox_dims(d_bbox)
        if d_cx is None:
            merged.append(d)
            continue

        best_km = None
        best_dist = float('inf')
        for ki, k in enumerate(km_items):
            if ki in used_km:
                continue
            k_bbox = k.get('bbox')
            if k_bbox is None or len(k_bbox) < 4:
                continue
            k_cx, k_cy = _bbox_center(k_bbox)
            k_w, k_h = _bbox_dims(k_bbox)
            if k_cx is None:
                continue

            y_diff = abs(d_cy - k_cy)
            avg_h = max(d_h or 1, k_h or 1)
            if y_diff > avg_h * 0.6:
                continue

            x_dist = abs(d_cx - k_cx) - (d_w or 0) / 2 - (k_w or 0) / 2
            if x_dist < 0:
                x_dist = 0
            total_dist = ((k_cx - d_cx) ** 2 + (k_cy - d_cy) ** 2) ** 0.5

            if total_dist < best_dist:
                best_dist = total_dist
                best_km = ki

        if best_km is not None and best_dist < max(d_h or 30, 30) * 5:
            k = km_items[best_km]
            combined_text = d['text'] + k['text']
            combined_conf = (d['confidence'] + k['confidence']) / 2
            merged.append({
                'text': combined_text,
                'confidence': combined_conf,
                'bbox': None,
                'merged_from': [d['text'], k['text']],
            })
            used_km.add(best_km)
        else:
            merged.append(d)

    for ki, k in enumerate(km_items):
        if ki not in used_km:
            merged.append(k)

    return merged


def recognize(image_bytes, options=None):
    options = options or {}
    start_time = time.time()

    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'mileage': None, 'error': 'image not readable'}

    # Phase 1: original + grayscale + LED (3 variants, ~3-5s)
    image_height = image.shape[0]
    phase1_variants = _make_phase1_variants(image)
    phase1_y_offsets = [0.0] * len(phase1_variants)
    phase1_results_raw = _ocr_variants(phase1_variants, image_height, phase1_y_offsets)

    # Phase 1 without merging
    best, grouped, all_sorted = _process_ocr_results(phase1_results_raw, options)

    if _check_phase1_done(grouped):
        elapsed = time.time() - start_time
        print(f'Phase 1 OK: {best["mileage"]} km={best["has_km"]} c={best["avg_confidence"]:.2f} x{best["count"]} {elapsed:.1f}s', flush=True)
        return _format_result(best, all_sorted, options)

    # Phase 1 didn't find good result — try merging digit+km fragments
    phase1_merged = _merge_fragments_smart(phase1_results_raw)
    best_m, grouped_m, all_sorted_m = _process_ocr_results(phase1_merged, options)
    if best_m and best_m['has_km'] and not best_m['is_noise']:
        elapsed = time.time() - start_time
        print(f'Phase 1+merge OK: {best_m["mileage"]} km={best_m["has_km"]} c={best_m["avg_confidence"]:.2f} x{best_m["count"]} {elapsed:.1f}s', flush=True)
        return _format_result(best_m, all_sorted_m, options)

    # Phase 2: crops + inversion + aggressive preprocessing
    phase2_variants, phase2_y_offsets = _make_phase2_variants(image)
    phase2_results_raw = _ocr_variants(phase2_variants, image_height, phase2_y_offsets)

    all_results_raw = phase1_results_raw + phase2_results_raw
    best, grouped, all_sorted = _process_ocr_results(all_results_raw, options)

    if best and best['has_km'] and not best['is_noise']:
        elapsed = time.time() - start_time
        print(f'Phase 2 OK: {best["mileage"]} km={best["has_km"]} c={best["avg_confidence"]:.2f} x{best["count"]} {elapsed:.1f}s', flush=True)
        return _format_result(best, all_sorted, options)

    # Phase 2 didn't find km result — try merging
    all_merged = _merge_fragments_smart(all_results_raw)
    all_results_with_merged = all_results_raw + all_merged
    best_m2, grouped_m2, all_sorted_m2 = _process_ocr_results(all_results_with_merged, options)
    if best_m2:
        best = best_m2
        all_sorted = all_sorted_m2

    # Phase 3: aggressive crops targeting odometer area (only if no km result found)
    phase3_improved = False
    if not (best and best['has_km'] and not best.get('is_noise')):
        phase3_variants, phase3_y_offsets = _make_phase3_variants(image)
        phase3_results_raw = _ocr_variants(phase3_variants, image_height, phase3_y_offsets)

        all_with_p3 = all_results_raw + phase3_results_raw
        all_merged_p3 = all_with_p3 + _merge_fragments_smart(all_with_p3)
        best_p3, grouped_p3, all_sorted_p3 = _process_ocr_results(all_merged_p3, options)

        if best_p3 and (not best or
                        (best_p3['has_km'] and not best_p3.get('is_noise') and not (best and best.get('has_km') and not best.get('is_noise'))) or
                        (not (best and best.get('has_km') and not best.get('is_noise')) and best_p3['avg_confidence'] > (best['avg_confidence'] if best else 0))):
            best = best_p3
            all_sorted = all_sorted_p3
            phase3_improved = True

    elapsed = time.time() - start_time
    if best:
        phase_label = 'Phase 3' if phase3_improved else 'Phase 2+merge'
        print(f'{phase_label} OK: {best["mileage"]} km={best["has_km"]} c={best["avg_confidence"]:.2f} x{best["count"]} {elapsed:.1f}s', flush=True)
    else:
        print(f'ALL FAIL: no result {elapsed:.1f}s', flush=True)

    return _format_result(best, all_sorted, options)


def _format_result(best, all_sorted, options):
    options = options or {}
    min_mileage = options.get('min_mileage', MIN_MILEAGE)

    mileage = best['mileage'] if best else None

    output_groups = [
        {'mileage': g['mileage'], 'count': g['count'],
         'avg_confidence': round(g['avg_confidence'], 4),
         'max_confidence': round(g['max_confidence'], 4),
         'has_km': g.get('has_km', False), 'is_noise': g.get('is_noise', False),
         'is_upper': g.get('is_upper', False)}
        for g in all_sorted[:15] if g['mileage'] >= min_mileage or g.get('has_km')
    ]

    return {
        'mileage': mileage,
        'selected': {
            'mileage': best['mileage'] if best else None,
            'count': best['count'] if best else 0,
            'avg_confidence': round(best['avg_confidence'], 4) if best else 0,
            'max_confidence': round(best['max_confidence'], 4) if best else 0,
        },
        'thresholds': {
            'min_mileage': min_mileage,
            'min_count': MIN_COUNT,
            'min_avg_conf': MIN_AVG_CONF,
            'min_max_conf': MIN_MAX_CONF,
        },
        'groups': output_groups,
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
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(json.dumps({'mileage': None, 'error': 'usage: rapidocr_server.py [--server] [image_path]'}))


if __name__ == '__main__':
    main()