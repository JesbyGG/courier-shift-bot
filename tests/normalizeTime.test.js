const path = require('path');
const { roundMinutesToHalfHour } = require(path.join(__dirname, '..', 'utils.js'));

// Локальная копия normalizeTimeValue из bot.js — копируем, чтобы тестировать без require'а bot.js
// (bot.js при загрузке стартует Telegraf, что нежелательно в тестах).
function normalizeTimeValue(value) {
  const text = String(value || '').trim();

  const noSpaces = text.replace(/\s+/g, '');
  const colonMatch = noSpaces.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colonMatch) {
    const minutes = Number(colonMatch[2]);
    if (minutes > 59) return null;
    return roundMinutesToHalfHour(Number(colonMatch[1]), minutes);
  }

  const dotTimeMatch = text.match(/^(\d{1,2})[.\s]+(\d{2})$/);
  if (dotTimeMatch) {
    const minutes = Number(dotTimeMatch[2]);
    if (minutes > 59) return null;
    return roundMinutesToHalfHour(Number(dotTimeMatch[1]), minutes);
  }

  const dotDecimalMatch = text.match(/^(\d{1,2})[.\s]+(\d)$/);
  if (dotDecimalMatch) {
    const minutes = Math.round(Number(dotDecimalMatch[2]) * 6);
    return roundMinutesToHalfHour(Number(dotDecimalMatch[1]), minutes);
  }

  const decimalMatch = noSpaces.match(/^(\d{1,2})(?:,(\d{1,2}))?$/);
  if (decimalMatch) {
    const hours = Number(decimalMatch[1]);
    const fraction = decimalMatch[2] ? Number(`0.${decimalMatch[2]}`) : 0;
    const minutes = Math.round(fraction * 60);
    return roundMinutesToHalfHour(hours, minutes);
  }

  return null;
}

const cases = [
  // Точка + 2 цифры → время
  ['8.46', '9'],
  ['8.14', '8'],
  ['8.05', '8'],
  ['8.30', '8,5'],
  ['8.50', '9'],
  ['07.44', '7,5'],
  ['08.46', '9'],
  ['0.05', '0,0'],
  ['0.30', '0,5'],
  ['24.00', '24'],
  ['24.30', null],
  ['8.60', null],
  ['8.99', null],

  // Точка + 1 цифра → дробь
  ['8.5', '8,5'],
  ['0.5', '0,5'],
  ['7.3', '7,5'],
  ['7.7', '7,5'],
  ['8.1', '8'],
  ['8.9', '9'],

  // Пробел + 2 цифры → время
  ['8 14', '8'],
  ['8 46', '9'],
  ['8 30', '8,5'],
  ['8 05', '8'],
  ['8 50', '9'],
  ['0 30', '0,5'],
  ['24 00', '24'],
  ['8 60', null],

  // Пробел + 1 цифра → дробь
  ['8 5', '8,5'],
  ['7 3', '7,5'],
  ['0 5', '0,5'],

  // Двоеточие — всегда время
  ['8:46', '9'],
  ['8:14', '8'],
  ['8:30', '8,5'],
  ['8:05', '8'],
  ['8:5', '8'],
  ['07:44', '7,5'],
  ['0:00', '0,0'],
  ['24:00', '24'],
  ['24:30', null],
  ['8:60', null],
  ['07 : 44', '7,5'],

  // Запятая / целое — дробь
  ['8', '8'],
  ['8,5', '8,5'],
  ['7,3', '7,5'],
  ['7,75', '8'],
  ['0', '0,0'],   // [Фаза 1] раньше было "0", стало "0,0"
  ['1', '1,0'],   // [Фаза 1] раньше было "1", стало "1,0"
  ['24', '24'],
  ['25', null],
  ['7,5,5', null],

  // Краевые / мусор
  ['abc', null],
  ['', null],
  ['  ', null],
  ['8.123', null],
  ['8 5 30', null]
];

module.exports = {
  suite: 'normalizeTimeValue',
  tests: cases.map(([input, expected]) => ({
    name: `${JSON.stringify(input)} → ${expected === null ? 'null' : JSON.stringify(expected)}`,
    fn: (a) => a.equal(normalizeTimeValue(input), expected)
  }))
};
