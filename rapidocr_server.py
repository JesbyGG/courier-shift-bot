#!/usr/bin/env python3
"""
rapidocr_server_v4_simple.py — Simple equal split + CNN + first-digit fallback.
"""

import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path

import cv2
import numpy as np
import torch
import torchvision.transforms as T
from PIL import Image

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "digit_cnn_final.pth"

MIN_MILEAGE = int(os.getenv('OCR_MIN_MILEAGE', '100') or 100)
MAX_MILEAGE = 300000
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

print(f"CNN Simple loading... Device: {DEVICE}")

from torchvision.models import resnet18
model = resnet18(weights=None)
model.fc = torch.nn.Linear(model.fc.in_features, 10)
if MODEL_PATH.exists():
    model.load_state_dict(torch.load(str(MODEL_PATH), map_location=DEVICE))
    print(f"Loaded CNN from {MODEL_PATH}")
else:
    print(f"WARNING: Model not found!")
model = model.to(DEVICE)
model.eval()

cnn_transform = T.Compose([
    T.Resize((128, 128)),
    T.ToTensor(),
    T.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5])
])


def predict_digit(gray_img):
    # Invert colors for real photos (white digits on dark background -> black digits on light background)
    # This matches how synthetic training data looks
    inverted = cv2.bitwise_not(gray_img)
    
    rgb = cv2.cvtColor(inverted, cv2.COLOR_GRAY2RGB)
    pil = Image.fromarray(rgb)
    tensor = cnn_transform(pil).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        output = model(tensor)
        probs = torch.softmax(output, dim=1)
        conf, pred = probs.max(1)
    return pred.item(), conf.item()


def get_zone(image_gray):
    """Get odometer zone from photo."""
    h, w = image_gray.shape
    aspect = w / h
    
    if 0.7 <= aspect <= 1.4:
        # Close-up — use almost all
        return image_gray[int(h*0.05):int(h*0.95), int(w*0.02):int(w*0.98)]
    elif aspect > 1.4:
        # Dashboard — crop center-bottom where odometer usually is
        return image_gray[int(h*0.55):int(h*0.85), int(w*0.15):int(w*0.85)]
    else:
        # Tall photo — center crop
        return image_gray[int(h*0.3):int(h*0.7), int(w*0.1):int(w*0.9)]


def split_zone(zone_gray, n_digits):
    """Split zone into N equal parts."""
    h, w = zone_gray.shape
    
    # Remove km from right (10%)
    zone_gray = zone_gray[:, :int(w * 0.90)]
    h, w = zone_gray.shape
    
    if w < n_digits * 10:
        return None
    
    strip_w = w // n_digits
    digits = []
    confs = []
    
    for i in range(n_digits):
        x1 = i * strip_w
        x2 = w if i == n_digits - 1 else (i + 1) * strip_w
        strip = zone_gray[:, x1:x2]
        
        # Trim height
        h_s = strip.shape[0]
        y1 = int(h_s * 0.05)
        y2 = int(h_s * 0.95)
        strip = strip[y1:y2, :]
        
        # Pad to square
        h_s, w_s = strip.shape
        scale = 128 / max(h_s, w_s)
        new_h, new_w = int(h_s * scale), int(w_s * scale)
        resized = cv2.resize(strip, (new_w, new_h), interpolation=cv2.INTER_AREA)
        
        pad_top = (128 - new_h) // 2
        pad_bottom = 128 - new_h - pad_top
        pad_left = (128 - new_w) // 2
        pad_right = 128 - new_w - pad_left
        padded = cv2.copyMakeBorder(resized, pad_top, pad_bottom, pad_left, pad_right,
                                    cv2.BORDER_CONSTANT, value=0)
        
        pred, conf = predict_digit(padded)
        digits.append(str(pred))
        confs.append(conf)
    
    result_str = "".join(digits)
    avg_conf = sum(confs) / len(confs)
    min_conf = min(confs)
    
    return result_str, avg_conf, min_conf, confs


def recognize(image_bytes, options=None):
    options = options or {}
    start_time = time.time()
    
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return _format_error('image not readable')
    
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    zone = get_zone(gray)
    
    best = None
    best_score = 0
    
    for n in [6, 5, 4]:
        result = split_zone(zone, n)
        if result is None:
            continue
        
        digits_str, avg_conf, min_conf, all_confs = result
        
        # Fallback: first digit should be "1" in your fleet
        first_digit = digits_str[0]
        first_conf = all_confs[0]
        
        if first_digit != '1' and first_conf < 0.90:
            # Try "1" instead
            alt_str = '1' + digits_str[1:]
            # Calculate score for alternative
            # Adjust confidences: first digit gets penalty
            alt_avg = (0.85 + sum(all_confs[1:])) / len(all_confs)
            alt_min = min(0.85, min(all_confs[1:])) if len(all_confs) > 1 else 0.85
            alt_score = alt_avg * 0.6 + alt_min * 0.4
            
            # If alternative is better, use it
            original_score = avg_conf * 0.6 + min_conf * 0.4
            
            if n == 6:
                alt_score += 0.1
                original_score += 0.1 if digits_str.startswith('1') else 0
            
            if alt_score > original_score:
                digits_str = alt_str
                avg_conf = alt_avg
                min_conf = alt_min
                print(f"  FALLBACK first digit: '{first_digit}'->'1' (was {first_conf:.3f})")
        
        score = avg_conf * 0.6 + min_conf * 0.4
        
        if n == 6 and digits_str.startswith('1'):
            score += 0.05
        
        print(f"  Try {n}: {digits_str} (avg={avg_conf:.3f}, min={min_conf:.3f}, score={score:.3f})")
        
        if score > best_score:
            best_score = score
            best = {
                'mileage': int(digits_str),
                'conf': avg_conf,
                'min_conf': min_conf,
                'digits': n
            }
    
    elapsed = time.time() - start_time
    
    if best and MIN_MILEAGE <= best['mileage'] <= MAX_MILEAGE:
        print(f'CNN OK: {best["mileage"]} conf={best["conf"]:.3f} {elapsed:.2f}s')
        return _format_result(best, elapsed)
    
    print(f'CNN FAIL {elapsed:.2f}s')
    return _format_error('could not recognize')


def _format_result(best, elapsed):
    return {
        'mileage': best['mileage'],
        'selected': {
            'mileage': best['mileage'],
            'count': best['digits'],
            'avg_confidence': round(best['conf'], 4),
            'max_confidence': round(best['min_conf'], 4),
        },
        'thresholds': {
            'min_mileage': MIN_MILEAGE,
            'max_mileage': MAX_MILEAGE,
        },
        'groups': [{
            'mileage': best['mileage'],
            'count': best['digits'],
            'avg_confidence': round(best['conf'], 4),
            'max_confidence': round(best['min_conf'], 4),
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
            self.wfile.write(b'{"status":"ok","engine":"cnn_v4_simple"}')
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
        print(f'CNN OCR v4 Simple listening on 127.0.0.1:{port}', flush=True)
        server.serve_forever()
    else:
        print(json.dumps({'mileage': None, 'error': 'usage: rapidocr_server.py --server'}))


if __name__ == '__main__':
    main()
