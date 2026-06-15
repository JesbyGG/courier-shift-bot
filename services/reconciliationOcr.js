const axios = require('axios');
const { isGeminiOcrEnabled, recognizeTextWithGemini } = require('./mileageOcr');

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseMoneyRu(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // Preserve comma as decimal separator if present
  const hasComma = raw.includes(',');
  const cleaned = raw.replace(/[\s\u00A0]/g, '').replace(/₽/g, '');
  if (hasComma) {
    // Replace comma with dot for parsing, but keep original format
    const normalized = cleaned.replace(/,/g, '.');
    const number = Number(normalized.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(number) || number < 0) return null;
    return number;
  }
  const normalized = cleaned.replace(/[^0-9.]/g, '');
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

// Simple reconciliation: just get cash amount
async function recognizeReconciliationCashSimple(ctx, fileId) {
  try {
    const geminiOcrUrl = process.env.GEMINI_OCR_URL || '';
    if (!geminiOcrUrl) {
      console.error('Gemini OCR URL not configured');
      return null;
    }

    const link = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(link.href, { responseType: 'arraybuffer', timeout: 30000 });
    const imageBuffer = Buffer.from(response.data);

    const recUrl = geminiOcrUrl.replace(/\/+$/, '') + '/reconciliation';
    const ocrResponse = await axios.post(recUrl, imageBuffer, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/octet-stream' }
    });

    const data = ocrResponse.data;
    console.log('reconciliation simple OCR:', JSON.stringify(data));

    if (data.cash_amount) {
      const amount = parseMoneyRu(data.cash_amount);
      if (amount && amount > 0) {
        return amount;
      }
    }

    return null;
  } catch (error) {
    console.error('reconciliation simple OCR error:', error.message || error);
    return null;
  }
}

function extractOrdersCountFromOcrText(text) {
  const raw = String(text || '')
    .replace(/\u00A0/g, ' ')
    .trim();

  if (!raw) {
    return { totalOrders: null, reason: 'empty_text' };
  }

  const normalized = raw.replace(/\s+/g, ' ');

  const strictPatterns = [
    /заказо[кв]\s+за\s*(?:сегодня|сутки)\s*:?\s*(\d{1,5})/i,
    /за\s*(?:сегодня|сутки)\s*:?\s*(\d{1,5})/i,
  ];

  for (const pattern of strictPatterns) {
    const match = normalized.match(pattern);
    if (match && Number.isFinite(Number(match[1])) && Number(match[1]) > 0) {
      return { totalOrders: Number(match[1]), reason: 'ok' };
    }
  }

  const lines = raw.split(/\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/заказо[кв]/i.test(line)) {
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
        const candidate = lines[j].trim();
        const numMatch = candidate.match(/^(\d{1,5})$/);
        if (numMatch && Number.isFinite(Number(numMatch[1])) && Number(numMatch[1]) > 0) {
          return { totalOrders: Number(numMatch[1]), reason: 'ok' };
        }
      }
    }
  }

  const fallbackPatterns = [
    /заказо[кв]\s*:?\s*(\d{1,5})(?:\s|$)/i,
    /(\d{1,5})\s*заказо[кв]/i,
  ];

  for (const pattern of fallbackPatterns) {
    const match = normalized.match(pattern);
    if (match && Number.isFinite(Number(match[1])) && Number(match[1]) > 0) {
      return { totalOrders: Number(match[1]), reason: 'ok' };
    }
  }

  return { totalOrders: null, reason: 'no_orders_line' };
}

function extractCashFromOcrText(text) {
  const normalized = String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[|¦]/g, '/')
    .replace(/₽/g, ' ₽')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return { orders: null, amount: null, valid: false, reason: 'empty_text' };
  }

  const cashWordSource = 'налич[а-яa-z]*|[Hh]a[нn][лnM][иiч4][нn][ыb][еe]|[Hh]a[лn][иiч][нh][bл][еe]';
  const cashLineRegex = new RegExp(`(?:${cashWordSource})\\s*([0-9]{1,3})?\\s*/\\s*([0-9\\s.,]{1,20})?[P₽]?`, 'i');
  const cashMatch = normalized.match(cashLineRegex);

  if (cashMatch) {
    const ordersRaw = cashMatch[1] || '';
    const amountRaw = cashMatch[2] || '';
    const orders = Number(String(ordersRaw).replace(/\D/g, ''));
    const amount = parseMoneyRu(amountRaw);
    const hasOrders = Number.isFinite(orders) && orders > 0;
    const hasAmount = Number.isFinite(amount) && amount >= 1;

    return {
      orders: Number.isFinite(orders) ? orders : 0,
      amount: Number.isFinite(amount) ? amount : null,
      valid: hasOrders && hasAmount,
      reason: hasOrders && hasAmount ? 'ok' : 'insufficient'
    };
  }

  const hasCashWord = new RegExp(`(?:${cashWordSource})`, 'i').test(normalized);
  if (hasCashWord) {
    return { orders: 0, amount: null, valid: false, reason: 'cash_line_empty' };
  }

  return { orders: null, amount: null, valid: false, reason: 'no_cash_line' };
}

function getReconciliationOcrTimeoutMs() {
  const value = Number(process.env.RECONCILIATION_OCR_TIMEOUT_MS || 30000);
  return Number.isFinite(value) && value >= 5000 ? value : 30000;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function emptyReconciliationCash(reason, source = 'none') {
  return { orders: null, amount: null, totalOrders: null, valid: false, reason, source };
}

async function recognizeReconciliationCashSafe(ctx, fileId, label) {
  try {
    return await withTimeout(
      recognizeReconciliationCash(ctx, fileId),
      getReconciliationOcrTimeoutMs(),
      `reconciliation OCR ${label || ''}`.trim()
    );
  } catch (error) {
    console.error('reconciliation OCR safe fallback', label || '', error.message || error);
    return emptyReconciliationCash('ocr_timeout', 'none');
  }
}

function shouldWarnAboutReconciliationOcr(cashInfo) {
  if (!cashInfo) return true;
  if (cashInfo.valid) return false;
  if (cashInfo.totalOrders && cashInfo.totalOrders > 0) return false;
  return ['ocr_timeout', 'error', 'local_ocr_error', 'local_ocr_timeout', 'no_ocr_result'].includes(cashInfo.reason);
}

async function recognizeReconciliationCash(ctx, fileId) {
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(link.href, { responseType: 'arraybuffer', timeout: 30000 });
    const imageBuffer = Buffer.from(response.data);

    let totalOrdersFromGemini = null;

    if (isGeminiOcrEnabled()) {
      const geminiText = await recognizeTextWithGemini(imageBuffer);
      if (geminiText) {
        const parsed = extractCashFromOcrText(geminiText);
        const ordersParsed = extractOrdersCountFromOcrText(geminiText);
        totalOrdersFromGemini = ordersParsed.totalOrders;
        console.log('сверка OCR:', JSON.stringify({ cashValid: parsed.valid, cashReason: parsed.reason, cashOrders: parsed.orders, cashAmount: parsed.amount, totalOrders: ordersParsed.totalOrders, ordersReason: ordersParsed.reason, source: 'gemini' }));

        if (parsed.valid) {
          return { ...parsed, totalOrders: ordersParsed.totalOrders, source: 'gemini' };
        }

        if (parsed.reason === 'cash_line_empty') {
          return { ...parsed, totalOrders: ordersParsed.totalOrders, source: 'gemini' };
        }
      } else {
        console.log('сверка OCR: Gemini OCR вернул пустой текст');
      }
    }

    console.log('сверка OCR: Gemini OCR не дал результата, fallback-OCR не подключён');
    return { orders: null, amount: null, totalOrders: totalOrdersFromGemini, valid: false, reason: 'no_ocr_result', source: 'none' };
  } catch (error) {
    console.error('reconciliation cash recognition error', error.message || error);
    return { orders: null, amount: null, totalOrders: null, valid: false, reason: 'error', source: 'none' };
  }
}

module.exports = {
  getReconciliationOcrTimeoutMs,
  roundMoney,
  emptyReconciliationCash,
  recognizeReconciliationCashSafe,
  shouldWarnAboutReconciliationOcr,
  recognizeReconciliationCash,
  recognizeReconciliationCashSimple,
  extractCashFromOcrText,
  extractOrdersCountFromOcrText,
  parseMoneyRu
};
