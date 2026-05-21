import json
import sys
import os
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

ENGINE = RapidOCR()

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

def diagnose(image_path):
    image = cv2.imread(image_path)
    if image is None:
        print(json.dumps({'error': 'image not readable'}))
        return

    _, buf = cv2.imencode('.jpg', image)
    nparr = np.frombuffer(buf.tobytes(), np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

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
            all_texts.append({
                'variant': i,
                'text': text,
                'confidence': confidence,
                'mileage': mileage
            })

    # Group by mileage
    by_mileage = {}
    for item in all_texts:
        m = item['mileage']
        if m:
            by_mileage.setdefault(m, []).append(item)

    print(json.dumps({
        'file': image_path,
        'all_texts': all_texts,
        'by_mileage': {str(k): v for k, v in by_mileage.items()}
    }, ensure_ascii=True, indent=2))

if __name__ == '__main__':
    diagnose(sys.argv[1])
