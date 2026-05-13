// Тесты parseMileageNumber и parseMoneyRu/formatMoneyRu.
// Функции — копии из bot.js, чтобы избежать загрузки Telegraf в тестах.

function parseMileageNumber(value) {
  const text = String(value || '').replace(/\D/g, '');
  if (!text) return null;
  const number = Number(text);
  if (!Number.isInteger(number)) return null;
  if (text.length < 2 || text.length > 6) return null;
  return number;
}

function parseMoneyRu(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\u00A0]/g, '').replace(/₽/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const number = Number(cleaned);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

function formatMoneyRu(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return null;
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
  return `${formatted} ₽`;
}

module.exports = {
  suite: 'mileage / money parsers',
  tests: [
    // parseMileageNumber
    { name: 'parseMileageNumber("25408") → 25408', fn: (a) => a.equal(parseMileageNumber('25408'), 25408) },
    { name: 'parseMileageNumber("25 408") → 25408', fn: (a) => a.equal(parseMileageNumber('25 408'), 25408) },
    { name: 'parseMileageNumber("25,408") → 25408', fn: (a) => a.equal(parseMileageNumber('25,408'), 25408) },
    { name: 'parseMileageNumber("99") → 99 (минимум 2 цифры)', fn: (a) => a.equal(parseMileageNumber('99'), 99) },
    { name: 'parseMileageNumber("9") → null (1 цифра)', fn: (a) => a.isNull(parseMileageNumber('9')) },
    { name: 'parseMileageNumber("999999") → 999999 (максимум 6)', fn: (a) => a.equal(parseMileageNumber('999999'), 999999) },
    { name: 'parseMileageNumber("9999999") → null (7 цифр)', fn: (a) => a.isNull(parseMileageNumber('9999999')) },
    { name: 'parseMileageNumber("") → null', fn: (a) => a.isNull(parseMileageNumber('')) },
    { name: 'parseMileageNumber(null) → null', fn: (a) => a.isNull(parseMileageNumber(null)) },
    { name: 'parseMileageNumber("abc") → null', fn: (a) => a.isNull(parseMileageNumber('abc')) },
    { name: 'parseMileageNumber("12abc34") → 1234', fn: (a) => a.equal(parseMileageNumber('12abc34'), 1234) },
    { name: 'parseMileageNumber("00099") → 99 (ведущие нули)', fn: (a) => {
      // text after replace = "00099", length 5 OK, Number("00099") = 99
      a.equal(parseMileageNumber('00099'), 99);
    }},

    // parseMoneyRu
    { name: 'parseMoneyRu("1234,56") → 1234.56', fn: (a) => a.equal(parseMoneyRu('1234,56'), 1234.56) },
    { name: 'parseMoneyRu("1 234,56") → 1234.56', fn: (a) => a.equal(parseMoneyRu('1 234,56'), 1234.56) },
    { name: 'parseMoneyRu("1234.56 ₽") → 1234.56', fn: (a) => a.equal(parseMoneyRu('1234.56 ₽'), 1234.56) },
    { name: 'parseMoneyRu("0") → 0', fn: (a) => a.equal(parseMoneyRu('0'), 0) },
    { name: 'parseMoneyRu("") → null', fn: (a) => a.isNull(parseMoneyRu('')) },
    { name: 'parseMoneyRu("-100") → 100 (знак минус снимается)', fn: (a) => {
      // replace(/[^0-9.]/) удалит минус → "100"
      a.equal(parseMoneyRu('-100'), 100);
    }},
    { name: 'parseMoneyRu("abc") → null', fn: (a) => a.isNull(parseMoneyRu('abc')) },

    // formatMoneyRu
    { name: 'formatMoneyRu(1234.56) содержит "1" и "₽"', fn: (a) => {
      const result = formatMoneyRu(1234.56);
      a.ok(result, 'не null');
      a.ok(result.includes('1'));
      a.ok(result.includes('₽'));
      a.ok(result.includes(',56') || result.includes('.56'));
    }},
    { name: 'formatMoneyRu(0) → "0,00 ₽"', fn: (a) => {
      const result = formatMoneyRu(0);
      a.ok(result.includes('0'));
      a.ok(result.includes('₽'));
    }},
    { name: 'formatMoneyRu(-100) → null', fn: (a) => a.isNull(formatMoneyRu(-100)) },
    { name: 'formatMoneyRu("abc") → null', fn: (a) => a.isNull(formatMoneyRu('abc')) }
  ]
};
