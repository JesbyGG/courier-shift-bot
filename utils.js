function normalizeFio(fio) {
  return String(fio || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .toLowerCase();
}

function normalizeFioWords(fio) {
  return normalizeFio(fio)
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

function getColumnLetter(columnNumber) {
  let number = Number(columnNumber);
  let letter = '';

  while (number > 0) {
    const remainder = (number - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    number = Math.floor((number - 1) / 26);
  }

  return letter;
}

function getCourierColumnsByDay(day) {
  return {
    startColumn: 6 + 3 * (day - 1),
    endColumn: 7 + 3 * (day - 1),
    hoursColumn: 8 + 3 * (day - 1)
  };
}

function getMileageColumnsByDay(day) {
  return {
    startColumn: 4 + 3 * (day - 1),
    endColumn: 5 + 3 * (day - 1),
    totalColumn: 6 + 3 * (day - 1)
  };
}

function roundMinutesToHalfHour(hours, minutes) {
  let h = Number(hours);
  let m = Number(minutes);

  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

  // Переполнение минут (например, 7:75) переносим в часы
  if (m >= 60) {
    h += Math.floor(m / 60);
    m = m % 60;
  }

  if (m < 0 || h < 0) return null;

  if (m < 15) {
    if (h > 24) return null;
    // Для 0 и 1 часов выводим в формате "H,0", чтобы не пересекаться
    // со schedule-маркером "1" и не попадать под isEmptyCell.
    // Для остальных часов — простой формат без дробной части.
    if (h <= 1) return `${h},0`;
    return String(h);
  }

  if (m < 45) {
    if (h > 23) return null; // 24,5 не имеет смысла
    return `${h},5`;
  }

  h += 1;
  if (h > 24) return null;
  // Аналогично — для 0 и 1 часов после переноса
  if (h <= 1) return `${h},0`;
  return String(h);
}

function roundTimeToHalfHour(input = new Date()) {
  let h;
  let m;
  if (input instanceof Date) {
    h = input.getHours();
    m = input.getMinutes();
  } else if (input && typeof input === 'object' && Number.isFinite(input.hour) && Number.isFinite(input.minute)) {
    h = input.hour;
    m = input.minute;
  } else {
    return null;
  }
  return roundMinutesToHalfHour(h, m);
}

function getDateInTimezone(timezone = 'Europe/Moscow', dateInput = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(dateInput);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour === '24' ? '0' : values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);

  return { year, month, day, hour, minute, second };
}

function getCurrentDateInfo(timezone = 'Europe/Moscow', overrideDate = null) {
  const parts = overrideDate
    ? getDateInTimezone(timezone, new Date(overrideDate))
    : getDateInTimezone(timezone);

  const dateText = `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`;

  return { ...parts, dateText, day: parts.day };
}

function isEmptyCell(value) {
  if (value === undefined || value === null) return true;
  const s = String(value).trim();
  return s === '';
  // ВАЖНО: раньше "0" и "1" считались пустыми, но это пересекалось с
  // реальными временами 00:00-00:14 ("0") и 00:45-01:14 ("1") — следующий
  // пунч молча затирал их. Теперь время для этих часов выводится как
  // "0,0" и "1,0" (см. roundMinutesToHalfHour), а пустыми считаются только
  // действительно пустые строки. Schedule-маркер "1" обрабатывается отдельно
  // через isScheduleMarker — см. punchTime/prepareMileage.
}

function isScheduleMarker(value) {
  if (value === undefined || value === null) return false;
  const s = String(value).trim();
  return s === '1';
}

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

function styledButton(text, callbackData, style) {
  const btn = { text, callback_data: callbackData };
  if (style) btn.style = style;
  return btn;
}

function styledReplyButton(text, style) {
  const btn = { text };
  if (style) btn.style = style;
  return btn;
}

module.exports = {
  normalizeFio,
  normalizeFioWords,
  getColumnLetter,
  getCourierColumnsByDay,
  getMileageColumnsByDay,
  roundTimeToHalfHour,
  roundMinutesToHalfHour,
  getCurrentDateInfo,
  isEmptyCell,
  isScheduleMarker,
  withTimeout,
  styledButton,
  styledReplyButton
};
