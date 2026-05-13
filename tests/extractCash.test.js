// Тесты extractCashFromOcrText из bot.js. Копируем функцию локально.

function parseMoneyRu(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\u00A0]/g, '').replace(/₽/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const number = Number(cleaned);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
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

  const amountPattern = /([0-9]{1,3})\s*\/\s*([0-9\s.,]{1,20})\s*[P₽]/i;
  const amountMatch = normalized.match(amountPattern);
  if (amountMatch) {
    const orders = Number(String(amountMatch[1] || '').replace(/\D/g, ''));
    const amount = parseMoneyRu(amountMatch[2]);
    const hasOrders = Number.isFinite(orders) && orders > 0;
    const hasAmount = Number.isFinite(amount) && amount >= 1;

    if (hasOrders && hasAmount) {
      return { orders, amount, valid: true, reason: 'ok' };
    }
  }

  const hasCashWord = new RegExp(`(?:${cashWordSource})`, 'i').test(normalized);
  if (hasCashWord) {
    return { orders: 0, amount: null, valid: false, reason: 'cash_line_empty' };
  }

  return { orders: null, amount: null, valid: false, reason: 'no_cash_line' };
}

module.exports = {
  suite: 'extractCashFromOcrText',
  tests: [
    { name: 'пустая строка → empty_text', fn: (a) => {
      const r = extractCashFromOcrText('');
      a.equal(r.valid, false);
      a.equal(r.reason, 'empty_text');
    }},

    { name: 'строка без слова "наличные" → no_cash_line', fn: (a) => {
      const r = extractCashFromOcrText('какой-то случайный текст без денег');
      a.equal(r.valid, false);
      a.equal(r.reason, 'no_cash_line');
    }},

    { name: 'наличные 5 / 1234,56 ₽ → valid', fn: (a) => {
      const r = extractCashFromOcrText('наличные 5 / 1234,56 ₽');
      a.equal(r.valid, true);
      a.equal(r.orders, 5);
      a.equal(r.amount, 1234.56);
    }},

    { name: 'Наличными 3 / 567 → valid', fn: (a) => {
      const r = extractCashFromOcrText('Наличными 3 / 567');
      a.equal(r.valid, true);
      a.equal(r.orders, 3);
      a.equal(r.amount, 567);
    }},

    { name: 'наличные слово есть, но без чисел → cash_line_empty', fn: (a) => {
      const r = extractCashFromOcrText('наличные');
      a.equal(r.valid, false);
      a.equal(r.reason, 'cash_line_empty');
    }},

    { name: 'паттерн N/MMM ₽ без слова "наличные" → valid', fn: (a) => {
      const r = extractCashFromOcrText('Итого 7 / 5000 ₽');
      a.equal(r.valid, true);
      a.equal(r.orders, 7);
      a.equal(r.amount, 5000);
    }},

    { name: 'OCR-шум с пайпом вместо слэша → парсится', fn: (a) => {
      const r = extractCashFromOcrText('наличные 2 | 1500');
      a.equal(r.valid, true);
      a.equal(r.orders, 2);
      a.equal(r.amount, 1500);
    }},

    { name: 'NBSP вместо обычного пробела → парсится', fn: (a) => {
      const r = extractCashFromOcrText('наличные\u00A02\u00A0/\u00A01000');
      a.equal(r.valid, true);
      a.equal(r.orders, 2);
    }},

    { name: '0 заказов, есть сумма → не valid', fn: (a) => {
      const r = extractCashFromOcrText('наличные 0 / 100');
      a.equal(r.valid, false);
    }}
  ]
};
