const path = require('path');
const {
  normalizeFio,
  getColumnLetter,
  getCourierColumnsByDay,
  getMileageColumnsByDay,
  roundMinutesToHalfHour,
  roundTimeToHalfHour,
  isEmptyCell,
  isScheduleMarker,
  getCurrentDateInfo
} = require(path.join(__dirname, '..', 'utils.js'));

module.exports = {
  suite: 'utils',
  tests: [
    // normalizeFio
    { name: 'normalizeFio: trim + lowercase', fn: (a) => {
      a.equal(normalizeFio('  Иванов Иван  '), 'иванов иван');
    }},
    { name: 'normalizeFio: ё→е', fn: (a) => {
      a.equal(normalizeFio('Ёлкин'), 'елкин');
    }},
    { name: 'normalizeFio: коллапс пробелов', fn: (a) => {
      a.equal(normalizeFio('Иван   Иванов'), 'иван иванов');
    }},
    { name: 'normalizeFio: null/undefined → пустая строка', fn: (a) => {
      a.equal(normalizeFio(null), '');
      a.equal(normalizeFio(undefined), '');
    }},

    // getColumnLetter
    { name: 'getColumnLetter: 1 → A', fn: (a) => a.equal(getColumnLetter(1), 'A') },
    { name: 'getColumnLetter: 26 → Z', fn: (a) => a.equal(getColumnLetter(26), 'Z') },
    { name: 'getColumnLetter: 27 → AA', fn: (a) => a.equal(getColumnLetter(27), 'AA') },
    { name: 'getColumnLetter: 52 → AZ', fn: (a) => a.equal(getColumnLetter(52), 'AZ') },
    { name: 'getColumnLetter: 53 → BA', fn: (a) => a.equal(getColumnLetter(53), 'BA') },

    // getCourierColumnsByDay
    { name: 'getCourierColumnsByDay(1) → start=6, end=7, hours=8', fn: (a) => {
      a.deepEqual(getCourierColumnsByDay(1), { startColumn: 6, endColumn: 7, hoursColumn: 8 });
    }},
    { name: 'getCourierColumnsByDay(2) → start=9, end=10, hours=11', fn: (a) => {
      a.deepEqual(getCourierColumnsByDay(2), { startColumn: 9, endColumn: 10, hoursColumn: 11 });
    }},

    // getMileageColumnsByDay
    { name: 'getMileageColumnsByDay(1) → start=4, end=5, total=6', fn: (a) => {
      a.deepEqual(getMileageColumnsByDay(1), { startColumn: 4, endColumn: 5, totalColumn: 6 });
    }},

    // roundMinutesToHalfHour — стандартные кейсы
    { name: 'roundMinutesToHalfHour(7, 0) → "7"', fn: (a) => a.equal(roundMinutesToHalfHour(7, 0), '7') },
    { name: 'roundMinutesToHalfHour(7, 14) → "7"', fn: (a) => a.equal(roundMinutesToHalfHour(7, 14), '7') },
    { name: 'roundMinutesToHalfHour(7, 15) → "7,5"', fn: (a) => a.equal(roundMinutesToHalfHour(7, 15), '7,5') },
    { name: 'roundMinutesToHalfHour(7, 30) → "7,5"', fn: (a) => a.equal(roundMinutesToHalfHour(7, 30), '7,5') },
    { name: 'roundMinutesToHalfHour(7, 44) → "7,5"', fn: (a) => a.equal(roundMinutesToHalfHour(7, 44), '7,5') },
    { name: 'roundMinutesToHalfHour(7, 45) → "8"', fn: (a) => a.equal(roundMinutesToHalfHour(7, 45), '8') },
    { name: 'roundMinutesToHalfHour(7, 59) → "8"', fn: (a) => a.equal(roundMinutesToHalfHour(7, 59), '8') },

    // Граничные
    { name: 'roundMinutesToHalfHour(23, 50) → "24"', fn: (a) => a.equal(roundMinutesToHalfHour(23, 50), '24') },
    { name: 'roundMinutesToHalfHour(24, 0) → "24"', fn: (a) => a.equal(roundMinutesToHalfHour(24, 0), '24') },
    { name: 'roundMinutesToHalfHour(24, 30) → null (24,5 не имеет смысла)', fn: (a) => a.isNull(roundMinutesToHalfHour(24, 30)) },
    { name: 'roundMinutesToHalfHour(25, 0) → null', fn: (a) => a.isNull(roundMinutesToHalfHour(25, 0)) },
    { name: 'roundMinutesToHalfHour(-1, 0) → null', fn: (a) => a.isNull(roundMinutesToHalfHour(-1, 0)) },

    // Переполнение минут
    { name: 'roundMinutesToHalfHour(7, 75) → "8,5" (75 мин = 8:15)', fn: (a) => a.equal(roundMinutesToHalfHour(7, 75), '8,5') },
    { name: 'roundMinutesToHalfHour(NaN, 0) → null', fn: (a) => a.isNull(roundMinutesToHalfHour(NaN, 0)) },

    // КРИТИЧЕСКИЕ — полночь и 1 ч (фаза 1)
    { name: '[Фаза 1] roundMinutesToHalfHour(0, 0) → "0,0" (не "0"!)', fn: (a) => a.equal(roundMinutesToHalfHour(0, 0), '0,0') },
    { name: '[Фаза 1] roundMinutesToHalfHour(0, 14) → "0,0"', fn: (a) => a.equal(roundMinutesToHalfHour(0, 14), '0,0') },
    { name: '[Фаза 1] roundMinutesToHalfHour(0, 15) → "0,5"', fn: (a) => a.equal(roundMinutesToHalfHour(0, 15), '0,5') },
    { name: '[Фаза 1] roundMinutesToHalfHour(0, 30) → "0,5"', fn: (a) => a.equal(roundMinutesToHalfHour(0, 30), '0,5') },
    { name: '[Фаза 1] roundMinutesToHalfHour(0, 45) → "1,0" (не "1"!)', fn: (a) => a.equal(roundMinutesToHalfHour(0, 45), '1,0') },
    { name: '[Фаза 1] roundMinutesToHalfHour(1, 0) → "1,0"', fn: (a) => a.equal(roundMinutesToHalfHour(1, 0), '1,0') },
    { name: '[Фаза 1] roundMinutesToHalfHour(1, 14) → "1,0"', fn: (a) => a.equal(roundMinutesToHalfHour(1, 14), '1,0') },
    { name: '[Фаза 1] roundMinutesToHalfHour(1, 15) → "1,5"', fn: (a) => a.equal(roundMinutesToHalfHour(1, 15), '1,5') },
    { name: '[Фаза 1] roundMinutesToHalfHour(1, 45) → "2"', fn: (a) => a.equal(roundMinutesToHalfHour(1, 45), '2') },
    { name: '[Фаза 1] roundMinutesToHalfHour(2, 0) → "2"', fn: (a) => a.equal(roundMinutesToHalfHour(2, 0), '2') },

    // roundTimeToHalfHour — обёртка через Date
    { name: 'roundTimeToHalfHour(Date 7:14) → "7"', fn: (a) => {
      a.equal(roundTimeToHalfHour(new Date(2026, 0, 1, 7, 14)), '7');
    }},
    { name: 'roundTimeToHalfHour(Date 7:15) → "7,5"', fn: (a) => {
      a.equal(roundTimeToHalfHour(new Date(2026, 0, 1, 7, 15)), '7,5');
    }},
    { name: '[Фаза 1] roundTimeToHalfHour(Date 0:10) → "0,0"', fn: (a) => {
      a.equal(roundTimeToHalfHour(new Date(2026, 0, 1, 0, 10)), '0,0');
    }},

    // isEmptyCell — Фаза 1
    { name: 'isEmptyCell(undefined) → true', fn: (a) => a.equal(isEmptyCell(undefined), true) },
    { name: 'isEmptyCell(null) → true', fn: (a) => a.equal(isEmptyCell(null), true) },
    { name: 'isEmptyCell("") → true', fn: (a) => a.equal(isEmptyCell(''), true) },
    { name: 'isEmptyCell("   ") → true', fn: (a) => a.equal(isEmptyCell('   '), true) },
    { name: '[Фаза 1] isEmptyCell("0") → false (раньше было true!)', fn: (a) => a.equal(isEmptyCell('0'), false) },
    { name: '[Фаза 1] isEmptyCell("1") → false (раньше было true!)', fn: (a) => a.equal(isEmptyCell('1'), false) },
    { name: 'isEmptyCell("0,0") → false', fn: (a) => a.equal(isEmptyCell('0,0'), false) },
    { name: 'isEmptyCell("7,5") → false', fn: (a) => a.equal(isEmptyCell('7,5'), false) },
    { name: 'isEmptyCell("7") → false', fn: (a) => a.equal(isEmptyCell('7'), false) },

    // isScheduleMarker — без изменений
    { name: 'isScheduleMarker("1") → true', fn: (a) => a.equal(isScheduleMarker('1'), true) },
    { name: 'isScheduleMarker("1,0") → false (это уже время!)', fn: (a) => a.equal(isScheduleMarker('1,0'), false) },
    { name: 'isScheduleMarker("0") → false', fn: (a) => a.equal(isScheduleMarker('0'), false) },
    { name: 'isScheduleMarker("") → false', fn: (a) => a.equal(isScheduleMarker(''), false) },
    { name: 'isScheduleMarker("7") → false', fn: (a) => a.equal(isScheduleMarker('7'), false) },

    // getCurrentDateInfo
    { name: 'getCurrentDateInfo возвращает объект с date/day/dateText', fn: (a) => {
      const info = getCurrentDateInfo('Europe/Moscow');
      a.ok(info.date instanceof Date);
      a.ok(typeof info.day === 'number' && info.day >= 1 && info.day <= 31);
      a.ok(/^\d{2}\.\d{2}\.\d{4}$/.test(info.dateText));
    }}
  ]
};
