const axios = require('axios');
const { isGeminiOcrEnabled, recognizeTextWithGemini } = require('./mileageOcr');
const { withTimeout } = require('../utils');

function parseMoneyRu(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const hasComma = raw.includes(',');
  const cleaned = raw.replace(/[\s\u00A0]/g, '').replace(/₽/g, '');
  if (hasComma) {
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

function extractCashFromGemini(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { amount: 0, totalOrders: 0, valid: false, reason: 'empty_text' };
  }

  let amount = 0;
  let totalOrders = 0;

  const cashMatch = raw.match(/CASH:\s*(\d+(?:[.,]\d+)?)/i);
  if (cashMatch) {
    amount = parseMoneyRu(cashMatch[1]) || 0;
  }

  const ordersMatch = raw.match(/ORDERS:\s*(\d+)/i);
  if (ordersMatch) {
    totalOrders = Number(ordersMatch[1]) || 0;
  }

  const hasAmount = amount >= 1;
  const hasOrders = totalOrders > 0;

  return {
    amount: hasAmount ? amount : 0,
    totalOrders,
    valid: hasAmount,
    reason: hasAmount ? 'ok' : (cashMatch ? 'amount_too_small' : 'no_cash_line')
  };
}

function getReconciliationOcrTimeoutMs() {
  const value = Number(process.env.RECONCILIATION_OCR_TIMEOUT_MS || 30000);
  return Number.isFinite(value) && value >= 5000 ? value : 30000;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function emptyReconciliationCash(reason, source = 'none') {
  return { amount: 0, totalOrders: 0, valid: false, reason, source };
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
  return ['ocr_timeout', 'error', 'no_ocr_result'].includes(cashInfo.reason);
}

async function recognizeReconciliationCash(ctx, fileId) {
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(link.href, { responseType: 'arraybuffer', timeout: 30000 });
    const imageBuffer = Buffer.from(response.data);

    if (isGeminiOcrEnabled()) {
      const geminiText = await recognizeTextWithGemini(imageBuffer);
      if (geminiText) {
        const parsed = extractCashFromGemini(geminiText);
        console.log('сверка OCR:', JSON.stringify({ cashValid: parsed.valid, cashReason: parsed.reason, cashAmount: parsed.amount, totalOrders: parsed.totalOrders, source: 'gemini' }));
        return { ...parsed, source: 'gemini' };
      } else {
        console.log('сверка OCR: Gemini OCR вернул пустой текст');
      }
    }

    console.log('сверка OCR: Gemini OCR не дал результата');
    return { amount: 0, totalOrders: 0, valid: false, reason: 'no_ocr_result', source: 'none' };
  } catch (error) {
    console.error('reconciliation cash recognition error', error.message || error);
    return { amount: 0, totalOrders: 0, valid: false, reason: 'error', source: 'none' };
  }
}

module.exports = {
  getReconciliationOcrTimeoutMs,
  roundMoney,
  emptyReconciliationCash,
  recognizeReconciliationCashSafe,
  shouldWarnAboutReconciliationOcr,
  recognizeReconciliationCash,
  extractCashFromGemini,
  parseMoneyRu
};
