import json
import os
import re
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ENGINE = RapidOCR()

# Конфигурация
MIN_MILEAGE = int(os.getenv('OCR_MIN_MILEAGE', '100') or 100)
MAX_MILEAGE = 300000

SPEEDOMETER_NUMBERS = {80, 100, 120, 140, 160, 180, 200, 220, 240, 260}
SPEEDOMETER_PAIRS = {"180200", "160180", "200220", "140160", "120140", "100120", "80100", "160200", "180220", "200240"}


def _is_speedometer_artifact(num):
    return str(num) in SPEEDOMETER_PAIRS or num > MAX_MILEAGE


def _is_dark_image(image):
    """Определяет, является ли фото тёмным (ночная съёмка)"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mean_brightness = np.mean(gray)
    return mean_brightness < 80  # порог для тёмных фото


def _gamma_correction(image, gamma=1.5):
    """Коррекция гаммы для осветления тёмных фото"""
    inv_gamma = 1.0 / gamma
    table = np.array([((i / 255.0) ** inv_gamma) * 255 for i in np.arange(0, 256)]).astype("uint8")
    return cv2.LUT(image, table)


def _preprocess_basic(crop):
    """Базовая предобработка: увеличение + CLAHE + denoise"""
    h, w = crop.shape[:2]
    scale = max(2.0, 600.0 / min(h, w))
    if scale > 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    
    # Для тёмных фото — gamma correction (очень сильное осветление)
    if _is_dark_image(crop):
        crop = _gamma_correction(crop, gamma=2.5)
    
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=5.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    denoise = cv2.fastNlMeansDenoising(gray, None, 12, 7, 21)
    return cv2.cvtColor(denoise, cv2.COLOR_GRAY2BGR)


def _preprocess_adaptive(crop):
    """Адаптивный threshold для выделения контуров цифр"""
    h, w = crop.shape[:2]
    scale = max(2.0, 600.0 / min(h, w))
    if scale > 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    
    if _is_dark_image(crop):
        crop = _gamma_correction(crop, gamma=2.5)
    
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=6.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    denoise = cv2.fastNlMeansDenoising(gray, None, 10, 5, 15)
    # Адаптивный threshold лучше для неравномерного освещения
    adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
    return cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR)


def _preprocess_led(crop, threshold=60):
    """Выделение ярких LED-сегментов (белые на тёмном фоне)"""
    h, w = crop.shape[:2]
    scale = max(2.0, 600.0 / min(h, w))
    if scale > 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    
    # Для тёмных фото — понижаем порог
    if _is_dark_image(crop):
        threshold = 35
        crop = _gamma_correction(crop, gamma=2.5)
    
    # HSV для выделения яркости
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    b, g, r = cv2.split(crop)
    brightness = np.maximum(np.maximum(r, g), b)
    
    # Только яркие пиксели
    _, led_mask = cv2.threshold(brightness, threshold, 255, cv2.THRESH_BINARY)
    led_only = cv2.bitwise_and(v, led_mask)
    
    # Проверяем, достаточно ли LED-пикселей
    if np.count_nonzero(led_only) < led_only.size * 0.003:
        return None
    
    # CLAHE + adaptive на LED
    clahe = cv2.createCLAHE(clipLimit=6.0, tileGridSize=(8, 8))
    led_clahe = clahe.apply(led_only)
    denoise = cv2.fastNlMeansDenoising(led_clahe, None, 8, 5, 15)
    adaptive = cv2.adaptiveThreshold(denoise, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5)
    return cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR)


def _preprocess_invert(crop):
    """Инверсия цветов для светлых цифр на тёмном фоне (LCD-одометр ночью)"""
    h, w = crop.shape[:2]
    scale = max(2.0, 600.0 / min(h, w))
    if scale > 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    
    if _is_dark_image(crop):
        crop = _gamma_correction(crop, gamma=2.5)
    
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # Инвертируем: светлые цифры станут чёрными на белом фоне
    inverted = cv2.bitwise_not(gray)
    clahe = cv2.createCLAHE(clipLimit=6.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(inverted)
    denoise = cv2.fastNlMeansDenoising(enhanced, None, 10, 5, 15)
    return cv2.cvtColor(denoise, cv2.COLOR_GRAY2BGR)


def _make_variants(image):
    """Создаёт несколько вариантов предобработки для OCR"""
    variants = []
    h, w = image.shape[:2]
    aspect = w / h
    
    # Определяем тип фото: крупный план (aspect ~1.0) или полный щиток (aspect > 1.5)
    is_closeup = 0.7 <= aspect <= 1.3
    
    # --- Вариант 1: основной кроп ---
    if is_closeup:
        # Крупный план одометра — берём ПОЧТИ ВСЁ (98%), чтобы не обрезать крайние цифры
        margin_x = int(w * 0.01)
        margin_y = int(h * 0.01)
    else:
        # Полный щиток — убираем края со спидометром
        margin_x = int(w * 0.15)
        margin_y = int(h * 0.20)
    
    crop = image[margin_y:h-margin_y, margin_x:w-margin_x]
    
    # Вариант 1a: базовый
    variants.append(_preprocess_basic(crop))
    
    # Вариант 1b: адаптивный threshold
    variants.append(_preprocess_adaptive(crop))
    
    # Вариант 1c: LED extraction (стандартный порог)
    led = _preprocess_led(crop, threshold=50)
    if led is not None:
        variants.append(led)
    
    # Вариант 1d: LED с низким порогом (для тёмных/засвеченных фото)
    led_low = _preprocess_led(crop, threshold=25)
    if led_low is not None and (led is None or not np.array_equal(led, led_low)):
        variants.append(led_low)
    
    # Вариант 1e: инверсия цветов (для тёмных фото со светлыми сегментами LCD)
    if _is_dark_image(crop):
        variants.append(_preprocess_invert(crop))
    
    # --- Вариант 2: полное изображение БЕЗ КРОПА (только для крупных планов) ---
    if is_closeup:
        variants.append(_preprocess_basic(image))
        variants.append(_preprocess_adaptive(image))
    
    # --- Вариант 3: нижний кроп (только для широких щитков) ---
    if not is_closeup:
        bottom_crop = image[int(h*0.50):h, int(w*0.10):int(w*0.90)]
        if bottom_crop.size > 0 and bottom_crop.shape[0] > 30:
            variants.append(_preprocess_basic(bottom_crop))
    
    return variants


def _extract_candidates(ocr_result):
    """Извлекает кандидаты пробега из OCR-результата"""
    candidates = []
    for item in ocr_result:
        if len(item) < 2:
            continue
        text = str(item[1]).strip()
        conf = float(item[2]) if len(item) > 2 else 0
        
        # Убираем пробелы, ищем 4-6 цифр подряд
        clean = text.replace(' ', '').replace('\n', '')
        matches = re.findall(r'\d{4,6}', clean)
        
        # DEBUG: логируем все найденные цифры для отладки темных фото
        all_digits = re.findall(r'\d+', clean)
        if all_digits:
            print(f'    DEBUG: digits in "{text}": {all_digits}', flush=True)
        
        for m in matches:
            num = int(m)
            # Фильтры
            if num in SPEEDOMETER_NUMBERS or _is_speedometer_artifact(num):
                continue
            if num < MIN_MILEAGE:
                continue
            
            has_km = bool(re.search(r'km|км|/km|ikm|lkm', text.lower()))
            candidates.append({
                'mileage': num,
                'conf': conf,
                'has_km': has_km,
                'text': text
            })
    return candidates


def recognize(image_bytes, options=None):
    """Главная функция распознавания"""
    options = options or {}
    start_time = time.time()
    
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return _format_error('image not readable')
    
    # Создаём варианты предобработки
    variants = _make_variants(image)
    
    # Собираем кандидатов со всех вариантов
    all_candidates = []
    for variant in variants:
        result, _ = ENGINE(variant)
        if result:
            candidates = _extract_candidates(result)
            all_candidates.extend(candidates)
    
    # --- Выбор лучшего кандидата ---
    best = None
    if all_candidates:
        # Группируем по значению пробега, усредняем confidence
        grouped = {}
        for c in all_candidates:
            m = c['mileage']
            if m not in grouped:
                grouped[m] = {'mileage': m, 'confs': [], 'has_km': False, 'count': 0}
            grouped[m]['confs'].append(c['conf'])
            grouped[m]['count'] += 1
            if c['has_km']:
                grouped[m]['has_km'] = True
        
        # Считаем средний conf и выбираем лучшего
        scored = []
        for g in grouped.values():
            avg_conf = sum(g['confs']) / len(g['confs'])
            # Score: conf*0.5 + count_ratio*0.3 + has_km*0.2
            max_count = max(gg['count'] for gg in grouped.values())
            count_score = (g['count'] / max_count) * 0.3 if max_count > 0 else 0
            km_score = 0.2 if g['has_km'] else 0
            score = avg_conf * 0.5 + count_score + km_score
            scored.append({
                'mileage': g['mileage'],
                'conf': avg_conf,
                'has_km': g['has_km'],
                'count': g['count'],
                'score': score
            })
        
        scored.sort(key=lambda x: x['score'], reverse=True)
        best = scored[0]
    
    # --- Fallback: если ровно 5 цифр >= 10000 — скорее всего потерялась ведущая "1" ---
    # В вашем парке все пробеги 6-значные, начинаются с "1" (100000+ км)
    # 5-значные пробеги (<100000) в вашем парке невозможны
    if best and len(str(best['mileage'])) == 5 and best['mileage'] >= 10000:
        corrected = int('1' + str(best['mileage']))
        if corrected <= MAX_MILEAGE:
            print(f'FALLBACK: added leading 1: {best["mileage"]} -> {corrected}', flush=True)
            best['mileage'] = corrected
            best['conf'] = best['conf'] * 0.85  # понижаем confidence из-за эвристики
    
    elapsed = time.time() - start_time
    
    if best:
        print(f'OK: {best["mileage"]} km={best["has_km"]} conf={best["conf"]:.2f} variants={len(variants)} {elapsed:.1f}s', flush=True)
    else:
        print(f'FAIL: no result variants={len(variants)} {elapsed:.1f}s', flush=True)
    
    return _format_result(best, scored if best else [], elapsed)


def _format_result(best, all_scored, elapsed):
    """Формирует JSON-ответ в формате, совместимом с bot.js"""
    output_groups = []
    seen = set()
    
    for s in all_scored:
        if s['mileage'] in seen:
            continue
        seen.add(s['mileage'])
        output_groups.append({
            'mileage': s['mileage'],
            'count': s['count'],
            'avg_confidence': round(s['conf'], 4),
            'max_confidence': round(s['conf'], 4),
            'has_km': s['has_km'],
            'is_noise': False,
            'is_upper': False,
        })
    
    # Сортируем по score
    output_groups.sort(key=lambda g: (g['has_km'], g['avg_confidence']), reverse=True)
    
    return {
        'mileage': best['mileage'] if best else None,
        'selected': {
            'mileage': best['mileage'] if best else None,
            'count': best['count'] if best else 0,
            'avg_confidence': round(best['conf'], 4) if best else 0,
            'max_confidence': round(best['conf'], 4) if best else 0,
        },
        'thresholds': {
            'min_mileage': MIN_MILEAGE,
            'max_mileage': MAX_MILEAGE,
        },
        'groups': output_groups[:10],
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
    """Распознавание полного текста (для сверки)"""
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {'error': 'image not readable', 'text_items': []}
    
    result, _ = ENGINE(image)
    items = []
    if result:
        for item in result:
            text = str(item[1]).strip() if len(item) > 1 else ''
            conf = float(item[2]) if len(item) > 2 else 0
            if text:
                items.append({'text': text, 'confidence': conf})
    
    return {'text_items': items}


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
        print(f'RapidOCR v3 server listening on 127.0.0.1:{port}', flush=True)
        server.serve_forever()
    else:
        print(json.dumps({'mileage': None, 'error': 'usage: rapidocr_server.py --server'}))


if __name__ == '__main__':
    main()
