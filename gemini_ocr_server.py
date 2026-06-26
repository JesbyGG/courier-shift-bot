#!/usr/bin/env python3
"""
OCR server: Gemini 2.5 Flash Lite (mileage + text).
"""

import json
import os
import sys
import time
import base64
import re
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = Path(__file__).resolve().parent

MIN_MILEAGE = int(os.getenv("OCR_MIN_MILEAGE", "100") or 100)
MAX_MILEAGE = 300000
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
if not GEMINI_API_KEY:
    try:
        _env_path = os.path.join(BASE_DIR, ".env")
        with open(_env_path) as _f:
            for _line in _f:
                _line = _line.strip()
                if _line.startswith("GEMINI_API_KEY="):
                    _val = _line.split("=", 1)[1].strip()
                    GEMINI_API_KEY = _val.strip("\"'")
                    break
    except Exception:
        pass
GEMINI_ENABLED = bool(GEMINI_API_KEY)

GEMINI_MAX_DIM = int(os.getenv("GEMINI_MAX_DIM", "1600") or 1600)
GEMINI_JPEG_QUALITY = int(os.getenv("GEMINI_JPEG_QUALITY", "90") or 90)
GEMINI_MAX_RETRIES = int(os.getenv("GEMINI_MAX_RETRIES", "5") or 5)
GEMINI_TIMEOUT = int(os.getenv("GEMINI_TIMEOUT", "60") or 60)
GEMINI_PRIMARY_MODEL = os.getenv("GEMINI_PRIMARY_MODEL", "gemini-3.1-flash-lite")
GEMINI_FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.1-flash-lite")


def optimize_image_for_ocr(image_bytes, max_dim=None, quality=None):
    """Resize, enhance contrast and sharpen image for better OCR."""
    if max_dim is None:
        max_dim = GEMINI_MAX_DIM
    if quality is None:
        quality = GEMINI_JPEG_QUALITY
    import cv2
    import numpy as np

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return image_bytes
    h, w = img.shape[:2]
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        img = cv2.resize(
            img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA
        )

    # Enhance contrast with CLAHE (helps with glare and low contrast)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    enhanced = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

    # Sharpen digits
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    sharpened = cv2.filter2D(enhanced, -1, kernel)

    _, encoded = cv2.imencode(".jpg", sharpened, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return encoded.tobytes()


def _call_gemini(
    image_bytes, system_prompt, model_name, max_retries=GEMINI_MAX_RETRIES
):
    """Send image to Gemini model and return lines list. Retries on 503."""
    for attempt in range(max_retries):
        lines, err = _call_gemini_once(image_bytes, system_prompt, model_name)
        if lines:
            return lines, None
        if err and "503" in str(err) and attempt < max_retries - 1:
            delay = 2**attempt
            print(
                f"Gemini [{model_name}] 503, retry {attempt + 2}/{max_retries} in {delay}s"
            )
            time.sleep(delay)
            continue
        return None, err
    return None, f"Gemini [{model_name}] unavailable after retries"


def _call_gemini_with_fallback(image_bytes, system_prompt):
    """Try primary model first, fallback to Pro if it fails."""
    primary = GEMINI_PRIMARY_MODEL or "gemini-2.5-flash"
    fallback = GEMINI_FALLBACK_MODEL or "gemini-2.5-pro"

    lines, err = _call_gemini(image_bytes, system_prompt, primary)
    if lines:
        return lines, None, primary

    print(f"Primary model {primary} failed: {err}. Trying fallback {fallback}...")
    lines, err = _call_gemini(image_bytes, system_prompt, fallback)
    if lines:
        return lines, None, fallback

    return None, err, None


def _call_gemini_once(image_bytes, system_prompt, model_name):
    """Send image to Gemini and return lines list."""
    api_key = GEMINI_API_KEY
    if not api_key:
        return None, "Gemini API key not configured"

    optimized = optimize_image_for_ocr(image_bytes)
    image_b64 = base64.b64encode(optimized).decode("utf-8")

    url = f"https://generativelanguage.googleapis.com/v1/models/{model_name}:generateContent?key={api_key}"
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": system_prompt},
                    {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}},
                ]
            }
        ]
    }
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=GEMINI_TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return None, f"Gemini HTTP {e.code} ({e.read().decode()[:200]})"
    except Exception as e:
        return None, f"Gemini error: {e}"

    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        return (
            None,
            f"Gemini unexpected response: {json.dumps(result, ensure_ascii=True)[:300]}",
        )

    if not text or not text.strip():
        return None, "Gemini returned empty text"

    lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
    return lines, None


MILEAGE_PROMPT = (
    "Ты смотришь на фото цифрового одометра автомобиля. На экране показан общий пробег.\n\n"
    "ВАЖНЕЙШЕЕ ПРАВИЛО: На многих одометрах последняя цифра пробега визуально отделена от остальных. "
    "Она может быть смещена в сторону, меньше по размеру, отделена точкой, пробелом или небольшим зазором. "
    "Эта отделённая цифра ВСЁ РАВНО является частью общего пробега и должна быть включена в итоговое число.\n\n"
    "Примеры:\n"
    "- Если на экране выглядит как '8985.3' → ответ: 89853\n"
    "- Если на экране выглядит как '8985 3' → ответ: 89853\n"
    "- Если на экране '17434' и рядом отдельно '1' → ответ: 174341\n"
    "- Если на экране '17434 1' → ответ: 174341\n\n"
    "Задание:\n"
    "1. Перечисли все цифры общего пробега по порядку, каждую на отдельной строке.\n"
    "2. На последней строке напиши полное число пробега целиком, включая отделённую последнюю цифру, без пробелов и точек.\n\n"
    "Формат ответа (только цифры, никаких слов или пояснений):\n"
    "1\n"
    "7\n"
    "4\n"
    "3\n"
    "4\n"
    "1\n"
    "174341"
)


def recognize_with_gemini(image_bytes):
    """Mileage OCR: returns (lines, error, model_name)."""
    return _call_gemini_with_fallback(image_bytes, MILEAGE_PROMPT)


def recognize_text_with_gemini(image_bytes):
    """Reconciliation OCR: returns (lines, error, model_name)."""
    lines, err, model = _call_gemini_with_fallback(
        image_bytes,
        "You are reading a delivery app order statistics page. "
        "1) CASH: Find the 'Наличные' (cash) payment method line. "
        "It shows format 'Наличные X / Y ₽' where Y is cash amount in rubles. "
        "If there is no amount shown or amount is 0,00, reply: CASH: 0. "
        "Otherwise reply the cash amount with comma as decimal separator. "
        "Important: read the FULL number including thousands separator. "
        "For example, '10 404,37' means ten thousand four hundred four rubles 37 kopecks. "
        "Reply: CASH: 10 404,37 (with space as thousands separator). "
        "2) ORDERS: Find the large number under 'ЗАКАЗОВ ЗА СЕГОДНЯ' (total orders for today). "
        "This is the TOTAL order count across ALL payment methods. "
        "Do NOT confuse with individual counts like 'Наличные 5' or 'Карта 3'. "
        "Reply ONLY in this exact format: "
        "CASH: <amount> ORDERS: <total integer> "
        "Example: CASH: 10 404,37 ORDERS: 22",
    )
    return lines, err, model


def _merge_decimal_like_separated_digits(text):
    """Convert patterns like '8985.3' or '17434.1' into '89853' / '174341'.

    Some odometers visually separate the last digit with a dot or small gap.
    The model may output it as a decimal. We treat a single digit after a dot
    or space as a continuation of the preceding integer.
    """
    # Pattern: integer followed by dot/space and exactly one digit (the rolling last digit)
    pattern = re.compile(r"(\d{2,})\s*\.\s*(\d)\b")
    while True:
        new_text = pattern.sub(r"\1\2", text)
        if new_text == text:
            break
        text = new_text
    return text


def extract_mileage_from_lines(lines):
    """Extract the most likely odometer value from Gemini response lines.

    Expected format (from step-by-step prompt): each digit on its own line,
    followed by the full number on the last line. We handle separated last
    digits (visually offset or shown after a dot/space) and prefer the longest
    valid number found.
    """
    if not lines:
        return None

    candidates = []

    # Strategy 1: last line is the full number.
    last_line = lines[-1].strip() if lines else None
    if last_line and re.fullmatch(r"\d+", last_line):
        val = int(last_line)
        if MIN_MILEAGE <= val <= MAX_MILEAGE:
            candidates.append((len(last_line), val))

    # Strategy 2: merge single-digit lines into one number.
    # Example: ['1','7','4','3','4','1','174341'] -> 174341 from single digits.
    single_digits = [ln.strip() for ln in lines if re.fullmatch(r"\d", ln.strip())]
    if len(single_digits) >= 2:
        merged = int("".join(single_digits))
        if MIN_MILEAGE <= merged <= MAX_MILEAGE:
            candidates.append((len(single_digits), merged))

    # Strategy 3: scan all numbers after merging spaced digits and decimal-like separators.
    text = "\n".join(lines)
    # First merge decimal-like separated digits: "8985.3" -> "89853"
    text = _merge_decimal_like_separated_digits(text)
    # Then merge regular spaces between digits across lines
    text = re.sub(r"(\d)\s+(?=\d)", r"\1", text)

    values = []
    for m in re.finditer(r"\d+", text):
        val = int(m.group())
        if MIN_MILEAGE <= val <= MAX_MILEAGE:
            values.append(val)
    if values:
        best = max(values, key=lambda v: (len(str(v)), v))
        candidates.append((len(str(best)), best))

    if not candidates:
        return None

    # Prefer the longest number; if lengths tie, prefer the larger value.
    return max(candidates, key=lambda item: (item[0], item[1]))[1]


# ===== Response formatting =====


def _format_mileage_result(mileage, elapsed, model_name="gemini"):
    if mileage is None:
        return _format_error("no mileage found")
    group = {
        "mileage": mileage,
        "count": 1,
        "avg_confidence": 1.0,
        "max_confidence": 1.0,
        "has_km": False,
        "is_noise": False,
    }
    return {
        "mileage": mileage,
        "engine": "gemini",
        "model": model_name,
        "selected": group,
        "thresholds": {"min_mileage": MIN_MILEAGE, "max_mileage": MAX_MILEAGE},
        "groups": [group],
        "elapsed": round(elapsed, 2),
    }


def _format_error(error_msg):
    return {
        "mileage": None,
        "engine": "error",
        "selected": {
            "mileage": None,
            "count": 0,
            "avg_confidence": 0,
            "max_confidence": 0,
        },
        "thresholds": {},
        "groups": [],
        "error": error_msg,
    }


def recognize_text(image_bytes):
    """Text recognition for /text endpoint. Gemini -> Tesseract fallback."""
    import cv2
    import numpy as np

    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        return {"text_items": []}

    # 1. Gemini (primary)
    if GEMINI_ENABLED:
        lines, err, model_name = recognize_text_with_gemini(image_bytes)
        if lines:
            print(f"Gemini text: {len(lines)} lines, preview: {lines[:3]}")
            return {
                "text_items": [{"text": line, "confidence": 0.95} for line in lines]
            }
        print(f"Gemini text fail: {err}")

    # 2. Tesseract (fallback)
    try:
        import pytesseract

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        text = pytesseract.image_to_string(rgb, lang="rus+eng", timeout=30)
        if text and text.strip():
            lines = [line.strip() for line in text.split("\n") if line.strip()]
            print(f"Tesseract text: {len(lines)} lines, preview: {lines[:3]}")
            return {"text_items": [{"text": line, "confidence": 0.9} for line in lines]}
        print("Tesseract returned empty text")
    except ImportError:
        print("pytesseract not installed")
    except Exception as e:
        print(f"Tesseract error: {e}")

    return {"text_items": []}


# ===== HTTP Server =====


class OcrHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0 or content_length > 20 * 1024 * 1024:
            self.send_response(400)
            self.end_headers()
            return
        body = self.rfile.read(content_length)
        try:
            if self.path == "/text":
                result = recognize_text(body)
            else:
                result = self._recognize(body)
        except Exception as e:
            import traceback

            traceback.print_exc()
            result = _format_error(str(e))
        response = json.dumps(result, ensure_ascii=True).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        try:
            self.wfile.write(response)
        except BrokenPipeError:
            pass

    def _recognize(self, image_bytes):
        """Mileage recognition: Gemini Flash primary, Pro fallback."""
        start = time.time()

        if not GEMINI_ENABLED:
            return _format_error("Gemini not configured")

        lines, err, model_name = recognize_with_gemini(image_bytes)
        if not lines:
            print(f"Gemini fail: {err}")
            return _format_error(err or "Gemini failed")

        mileage = extract_mileage_from_lines(lines)
        elapsed = time.time() - start

        if mileage:
            print(f"Gemini [{model_name}] OK: {mileage} {elapsed:.2f}s lines={lines}")
            return _format_mileage_result(mileage, elapsed, model_name)

        print(f"Gemini [{model_name}] no-valid: {elapsed:.2f}s lines={lines}")
        return _format_error("no mileage found in response")

    def do_GET(self):
        if self.path == "/health":
            engines = []
            if GEMINI_ENABLED:
                engines.append("gemini")
            try:
                import pytesseract

                engines.append("tesseract")
            except ImportError:
                pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "status": "ok",
                        "engine": "+".join(engines),
                        "gemini_enabled": GEMINI_ENABLED,
                    }
                ).encode()
            )
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--server":
        port = int(os.getenv("GEMINI_OCR_PORT", "9527") or 9527)
        server = ThreadingHTTPServer(("127.0.0.1", port), OcrHandler)
        print(f"OCR server listening on 127.0.0.1:{port}", flush=True)
        print(
            f"  Gemini 3.1 Flash Lite: {'ENABLED' if GEMINI_ENABLED else 'DISABLED (set GEMINI_API_KEY)'}",
            flush=True,
        )
        print(
            f"  Image optimize: {GEMINI_MAX_DIM}px, JPEG q{GEMINI_JPEG_QUALITY}",
            flush=True,
        )
        print(
            f"  Gemini retries: {GEMINI_MAX_RETRIES}, timeout: {GEMINI_TIMEOUT}s",
            flush=True,
        )
        try:
            import pytesseract

            print(f"  Tesseract: AVAILABLE (rus+eng)", flush=True)
        except ImportError:
            print(f"  Tesseract: NOT INSTALLED (pip install pytesseract)", flush=True)
        print(f"  MIN_MILEAGE={MIN_MILEAGE} MAX_MILEAGE={MAX_MILEAGE}", flush=True)
        server.serve_forever()
    else:
        print(
            json.dumps(
                {"mileage": None, "error": "usage: gemini_ocr_server.py --server"}
            )
        )


if __name__ == "__main__":
    main()
