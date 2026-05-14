const { JWT } = require('google-auth-library');
const {
  normalizeFio,
  getColumnLetter,
  getCourierColumnsByDay,
  getMileageColumnsByDay,
  roundTimeToHalfHour,
  getCurrentDateInfo,
  isEmptyCell,
  isScheduleMarker
} = require('./utils');
// WORKPLACES в этом файле не нужны напрямую — SHEET_CONFIGS использует
// строковые ключи и DEFAULT_CONFIG. Если позже понадобится — импортируем.

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let sheetsAuth;

function initGoogleSheets() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    throw new Error('Google service account credentials are not set');
  }

  sheetsAuth = new JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return sheetsAuth;
}

function getSheetsAuth() {
  if (!sheetsAuth) {
    return initGoogleSheets();
  }
  return sheetsAuth;
}

async function sheetsRequest({ method, path, params, data }) {
  const auth = getSheetsAuth();
  const url = `${SHEETS_BASE}/${path}`;
  const response = await auth.request({ method, url, params, data });
  return response;
}

const SHEET_CONFIGS = {
  'ИМ Восток': {
    courierSheet: 'Курьеры',
    mileageSheet: 'Пробег',
    mileageDayOffset: 0,
    courierFioColumn: 'D',
    mileageFioColumn: 'C',
    mileageAutoColumn: 'B',
    courierFioRange: 'C3:D',
    mileageFioRange: 'B3:C',
    efficiencySheet: 'Эффективность',
    efficiencyFioColumn: 'B',
    efficiencyFioRange: 'B3:B',
    efficiencyFirstDayCol: 7,
    efficiencyDayBlockSize: 3
  },
  'ИМ Центр': {
    courierSheet: 'Курьеры',
    mileageSheet: 'Пробег Курьеры',
    mileageDayOffset: 1,
    courierFioColumn: 'D',
    mileageFioColumn: 'D',
    mileageAutoColumn: 'C',
    courierFioRange: 'C3:D',
    mileageFioRange: 'B3:D',
    efficiencySheet: 'Эффективность',
    efficiencyFioColumn: 'B',
    efficiencyFioRange: 'B3:B',
    efficiencyFirstDayCol: 7,
    efficiencyDayBlockSize: 3
  }
};

const DEFAULT_CONFIG = SHEET_CONFIGS['ИМ Восток'];

function getSheetConfig(workplace) {
  return SHEET_CONFIGS[workplace] || DEFAULT_CONFIG;
}

function resolveSheetContext(workplace, options = {}) {
  const { resolveSheetInfo } = require('./storage');
  return resolveSheetInfo(workplace, options);
}

function getConfiguredSheetCandidates() {
  const candidates = [];
  const seen = new Set();

  for (const workplace of Object.keys(SHEET_CONFIGS)) {
    const context = resolveSheetContext(workplace);
    if (!context.sheetId) continue;

    const uniqueKey = `${workplace}:${context.sheetId}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);

    candidates.push({ workplace, sheetId: context.sheetId, monthKey: context.monthKey, source: context.source });
  }

  return candidates;
}

async function verifySheetAccess(sheetId) {
  try {
    const response = await sheetsRequest({
      method: 'GET',
      path: sheetId
    });

    const title = response.data.properties?.title || 'Без названия';
    const sheetsList = response.data.sheets?.map((s) => s.properties?.title) || [];

    const hasCouriers = sheetsList.includes('Курьеры');
    const hasMileage = sheetsList.includes('Пробег') || sheetsList.includes('Пробег Курьеры');

    return {
      ok: hasCouriers && hasMileage,
      title,
      sheets: sheetsList,
      hasCouriers,
      hasMileage,
      error: null
    };
  } catch (error) {
    const status = error.response?.status;
    let message = 'Не удалось подключиться к таблице.';

    if (status === 404) {
      message = 'Таблица не найдена. Проверьте ссылку.';
    } else if (status === 403) {
      const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
      message = serviceEmail
        ? `Нет доступа. Дайте доступ сервисному аккаунту бота:\n${serviceEmail}`
        : 'Нет доступа к таблице. Обратитесь к администратору.';
    }

    return {
      ok: false,
      title: null,
      sheets: [],
      hasCouriers: false,
      hasMileage: false,
      error: message
    };
  }
}

function quoteSheetName(sheetName) {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function getColumnNumber(columnLetter) {
  return String(columnLetter || '')
    .toUpperCase()
    .split('')
    .reduce((acc, char) => acc * 26 + (char.charCodeAt(0) - 64), 0);
}

function getRangeStartColumn(range) {
  const match = String(range || '').match(/^([A-Z]+)/i);
  return match ? getColumnNumber(match[1]) : null;
}

function getRowValueByColumn(row, range, columnLetter) {
  const startColumn = getRangeStartColumn(range);
  const targetColumn = getColumnNumber(columnLetter);

  if (!startColumn || !targetColumn) return '';
  const index = targetColumn - startColumn;
  if (index < 0) return '';

  return row[index] || '';
}

async function getValues(range, spreadsheetId) {
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID не задан. Используйте /sheet для привязки таблицы.');
  }

  const response = await sheetsRequest({
    method: 'GET',
    path: `${spreadsheetId}/values/${encodeURIComponent(range)}`
  });

  return response.data.values || [];
}

async function readCell(sheetName, cell, spreadsheetId) {
  const values = await getValues(`${quoteSheetName(sheetName)}!${cell}`, spreadsheetId);
  return values[0]?.[0] ?? '';
}

async function updateCell(sheetName, cell, value, spreadsheetId) {
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID не задан. Используйте /sheet для привязки таблицы.');
  }

  await sheetsRequest({
    method: 'PUT',
    path: `${spreadsheetId}/values/${encodeURIComponent(`${quoteSheetName(sheetName)}!${cell}`)}`,
    params: { valueInputOption: 'RAW' },
    data: { values: [[value]] }
  });
}

// Простой in-memory mutex по ключу (например, "spreadsheetId:row").
// Защищает read-modify-write от гонки при двойном тапе кнопки.
const _writeLocks = new Map();

async function withRowLock(key, fn) {
  const previous = _writeLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  // Цепляем в очередь: следующий захват ждёт ВСЕГО предыдущего pipeline
  _writeLocks.set(key, previous.then(() => next));

  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Очищаем, только если это был последний в цепочке (никто не встал после нас)
    if (_writeLocks.get(key) === next) {
      _writeLocks.delete(key);
    }
  }
}

async function findCourierByFio(fio, workplace, sheetContext = null) {
  const context = sheetContext || resolveSheetContext(workplace);
  const spreadsheetId = context.sheetId;
  if (!spreadsheetId) return null;

  const config = getSheetConfig(workplace);
  const rows = await getValues(`${quoteSheetName(config.courierSheet)}!${config.courierFioRange}`, spreadsheetId);
  const target = normalizeFio(fio);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowFio = getRowValueByColumn(row, config.courierFioRange, config.courierFioColumn) || row[row.length - 1] || '';

    if (normalizeFio(rowFio) === target) {
      return { row: index + 3, fio: rowFio, auto: row[0] || '', spreadsheetId };
    }
  }

  return null;
}

async function findMileageByFio(fio, workplace, sheetContext = null) {
  const context = sheetContext || resolveSheetContext(workplace);
  const spreadsheetId = context.sheetId;
  if (!spreadsheetId) return null;

  const config = getSheetConfig(workplace);
  const rows = await getValues(`${quoteSheetName(config.mileageSheet)}!${config.mileageFioRange}`, spreadsheetId);
  const target = normalizeFio(fio);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowFio = getRowValueByColumn(row, config.mileageFioRange, config.mileageFioColumn) || row[row.length - 1] || '';
    const auto = getRowValueByColumn(row, config.mileageFioRange, config.mileageAutoColumn) || row[0] || '';

    if (normalizeFio(rowFio) === target) {
      return { row: index + 3, fio: rowFio, auto, spreadsheetId };
    }
  }

  return null;
}

async function findCourierInAllSheets(fio) {
  const candidates = getConfiguredSheetCandidates();

  for (const candidate of candidates) {
    const spreadsheetId = candidate.sheetId;
    const workplace = candidate.workplace;
    const config = getSheetConfig(workplace);

    try {
      const response = await sheetsRequest({
        method: 'GET',
        path: spreadsheetId
      });
      const titles = response.data.sheets?.map((s) => s.properties?.title) || [];

      if (!titles.includes(config.courierSheet)) continue;

      const rows = await getValues(`${quoteSheetName(config.courierSheet)}!${config.courierFioRange}`, spreadsheetId);
      const target = normalizeFio(fio);

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const rowFio = getRowValueByColumn(row, config.courierFioRange, config.courierFioColumn) || row[row.length - 1] || '';

        if (normalizeFio(rowFio) === target) {
          return { row: index + 3, fio: rowFio, auto: row[0] || '', spreadsheetId, workplace };
        }
      }
    } catch (_) {
      continue;
    }
  }

  return null;
}

async function getTodayStatus(fio, workplace) {
  const ctx = await resolveCourierContext(fio, workplace);
  if (ctx.notFound) {
    if (ctx.noSheet) {
      return { notFound: true, noSheet: true, noSheetForMonth: ctx.noSheetForMonth, monthKey: ctx.monthKey };
    }
    return null;
  }

  const { spreadsheetId, config, courier, mileage } = ctx;

  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const { dateText, day } = getCurrentDateInfo(timezone);
  const courierColumns = getCourierColumnsByDay(day);
  const mileageColumns = getMileageColumns(workplace, day);

  const fromCell = `${getColumnLetter(courierColumns.startColumn)}${courier.row}`;
  const toCell = `${getColumnLetter(courierColumns.endColumn)}${courier.row}`;

  const mileageStartCell = `${getColumnLetter(mileageColumns.startColumn)}${mileage.row}`;
  const mileageEndCell = `${getColumnLetter(mileageColumns.endColumn)}${mileage.row}`;

  const [from, to, mileageStart, mileageEnd] = await Promise.all([
    readCell(config.courierSheet, fromCell, spreadsheetId),
    readCell(config.courierSheet, toCell, spreadsheetId),
    readCell(config.mileageSheet, mileageStartCell, spreadsheetId),
    readCell(config.mileageSheet, mileageEndCell, spreadsheetId)
  ]);

  const cleanMarker = (v) => isScheduleMarker(v) ? '' : v;

  return {
    fio: courier.fio,
    auto: courier.auto || mileage.auto,
    date: dateText,
    from: cleanMarker(from),
    to: cleanMarker(to),
    mileageStart,
    mileageEnd
  };
}

function makePunchState({ courier, mileage, dateText, day, stage, timeValue }) {
  return {
    fio: courier.fio,
    auto: courier.auto || mileage.auto,
    date: dateText,
    day,
    stage,
    courierRow: courier.row,
    mileageRow: mileage.row,
    timeValue
  };
}

function makeMileageState({ courier, mileage, dateText, day, stage }) {
  return {
    fio: courier.fio,
    auto: courier.auto || mileage.auto,
    date: dateText,
    day,
    stage,
    courierRow: courier.row,
    mileageRow: mileage.row
  };
}

function getMileageColumns(workplace, day) {
  const columns = getMileageColumnsByDay(day);
  const offset = getSheetConfig(workplace).mileageDayOffset || 0;

  return {
    startColumn: columns.startColumn + offset,
    endColumn: columns.endColumn + offset,
    totalColumn: columns.totalColumn + offset
  };
}

async function resolveCourierContext(fio, workplace) {
  const sheetContext = resolveSheetContext(workplace);
  const spreadsheetId = sheetContext.sheetId;
  if (!spreadsheetId) {
    return {
      sheetContext,
      spreadsheetId,
      config: null,
      courier: null,
      mileage: null,
      notFound: true,
      noSheet: true,
      noSheetForMonth: sheetContext.noSheetForMonth,
      monthKey: sheetContext.monthKey
    };
  }

  const config = getSheetConfig(workplace);
  const [courier, mileage] = await Promise.all([
    findCourierByFio(fio, workplace, sheetContext),
    findMileageByFio(fio, workplace, sheetContext)
  ]);

  if (!courier || !mileage) {
    return { sheetContext, spreadsheetId, config, courier, mileage, notFound: true };
  }

  return { sheetContext, spreadsheetId, config, courier, mileage, notFound: false };
}

async function prepareMileage(fio, workplace, stage = null) {
  const ctx = await resolveCourierContext(fio, workplace);
  if (ctx.notFound) {
    if (ctx.noSheet) {
      return { notFound: true, noSheet: true, noSheetForMonth: ctx.noSheetForMonth, monthKey: ctx.monthKey };
    }
    return { notFound: true };
  }

  const { spreadsheetId, config, courier, mileage } = ctx;

  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const { dateText, day } = getCurrentDateInfo(timezone);

  if (stage) {
    return makeMileageState({ courier, mileage, dateText, day, stage });
  }

  const columns = getMileageColumns(workplace, day);
  const startCell = `${getColumnLetter(columns.startColumn)}${mileage.row}`;
  const endCell = `${getColumnLetter(columns.endColumn)}${mileage.row}`;
  const [startMileage, endMileage] = await Promise.all([
    readCell(config.mileageSheet, startCell, spreadsheetId),
    readCell(config.mileageSheet, endCell, spreadsheetId)
  ]);

  if (isEmptyCell(startMileage) || isScheduleMarker(startMileage)) {
    return makeMileageState({ courier, mileage, dateText, day, stage: 'start' });
  }

  if (isEmptyCell(endMileage) || isScheduleMarker(endMileage)) {
    return makeMileageState({ courier, mileage, dateText, day, stage: 'end' });
  }

  return {
    needsReplaceChoice: true,
    fio: courier.fio,
    auto: courier.auto || mileage.auto,
    date: dateText,
    day,
    courierRow: courier.row,
    mileageRow: mileage.row,
    startMileage,
    endMileage
  };
}

async function punchTime(fio, workplace) {
  const ctx = await resolveCourierContext(fio, workplace);
  if (ctx.notFound) {
    if (ctx.noSheet) {
      return { notFound: true, noSheet: true, noSheetForMonth: ctx.noSheetForMonth, monthKey: ctx.monthKey };
    }
    return { notFound: true };
  }

  const { spreadsheetId, config, courier, mileage } = ctx;

  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const { dateText, day, date } = getCurrentDateInfo(timezone);
  const timeValue = roundTimeToHalfHour(date);
  const columns = getCourierColumnsByDay(day);
  const startCell = `${getColumnLetter(columns.startColumn)}${courier.row}`;
  const endCell = `${getColumnLetter(columns.endColumn)}${courier.row}`;

  // Mutex по ключу spreadsheetId:row защищает от race-condition при
  // двойном тапе. Без него оба параллельных вызова прочитали бы пустую
  // ячейку и оба написали бы — последний выиграл бы непредсказуемо.
  return withRowLock(`${spreadsheetId}:courier:${courier.row}`, async () => {
    const [from, to] = await Promise.all([
      readCell(config.courierSheet, startCell, spreadsheetId),
      readCell(config.courierSheet, endCell, spreadsheetId)
    ]);

    // Перезаписываем ячейку, если она пустая ИЛИ содержит schedule-маркер "1".
    // Маркер "1" означает «запланирована смена, но время ещё не внесено».
    // Реальные времена около 1:00 теперь пишутся как "1,0" — они НЕ затрутся.
    if (isEmptyCell(from) || isScheduleMarker(from)) {
      await updateCell(config.courierSheet, startCell, timeValue, spreadsheetId);
      return makePunchState({ courier, mileage, dateText, day, stage: 'start', timeValue });
    }

    if (isEmptyCell(to) || isScheduleMarker(to)) {
      await updateCell(config.courierSheet, endCell, timeValue, spreadsheetId);
      return makePunchState({ courier, mileage, dateText, day, stage: 'end', timeValue });
    }

    return {
      needsReplaceChoice: true,
      fio: courier.fio,
      auto: courier.auto || mileage.auto,
      date: dateText,
      day,
      courierRow: courier.row,
      mileageRow: mileage.row,
      timeValue,
      from,
      to
    };
  });
}

async function replaceTime(fio, workplace, stage) {
  const ctx = await resolveCourierContext(fio, workplace);
  if (ctx.notFound) {
    if (ctx.noSheet) {
      return { notFound: true, noSheet: true, noSheetForMonth: ctx.noSheetForMonth, monthKey: ctx.monthKey };
    }
    return { notFound: true };
  }

  const { courier, mileage } = ctx;

  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const { dateText, day, date } = getCurrentDateInfo(timezone);
  const timeValue = roundTimeToHalfHour(date);

  await updateCourierTime(courier.row, day, stage, timeValue, workplace);

  return makePunchState({ courier, mileage, dateText, day, stage, timeValue });
}

function requireSheetId(workplace) {
  const spreadsheetId = resolveSheetContext(workplace).sheetId;
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID не задан. Используйте /sheet для привязки таблицы.');
  }
  return { spreadsheetId, config: getSheetConfig(workplace) };
}

async function updateCourierTime(row, day, stage, value, workplace) {
  const { spreadsheetId, config } = requireSheetId(workplace);
  const columns = getCourierColumnsByDay(day);
  const columnNumber = stage === 'start' ? columns.startColumn : columns.endColumn;
  const cell = `${getColumnLetter(columnNumber)}${row}`;
  return withRowLock(`${spreadsheetId}:courier:${row}`, () =>
    updateCell(config.courierSheet, cell, value, spreadsheetId)
  );
}

async function updateMileage(row, day, stage, mileage, workplace) {
  const { spreadsheetId, config } = requireSheetId(workplace);
  const columns = getMileageColumns(workplace, day);
  const columnNumber = stage === 'start' ? columns.startColumn : columns.endColumn;
  const cell = `${getColumnLetter(columnNumber)}${row}`;
  return withRowLock(`${spreadsheetId}:mileage:${row}`, () =>
    updateCell(config.mileageSheet, cell, String(mileage), spreadsheetId)
  );
}

async function updateEfficiencyOrders(fio, workplace, day, ordersCount) {
  const config = getSheetConfig(workplace);
  if (!config.efficiencySheet) {
    return { ok: false, error: 'efficiency_sheet_not_configured' };
  }

  const sheetContext = resolveSheetContext(workplace);
  const spreadsheetId = sheetContext.sheetId;
  if (!spreadsheetId) {
    return { ok: false, error: 'no_sheet_id' };
  }

  const rows = await getValues(`${quoteSheetName(config.efficiencySheet)}!${config.efficiencyFioRange}`, spreadsheetId);
  const target = normalizeFio(fio);

  let foundRow = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowFio = getRowValueByColumn(row, config.efficiencyFioRange, config.efficiencyFioColumn) || row[row.length - 1] || '';
    if (normalizeFio(rowFio) === target) {
      foundRow = index + 3;
      break;
    }
  }

  if (!foundRow) {
    return { ok: false, error: 'fio_not_found' };
  }

  const ordersColumn = config.efficiencyFirstDayCol + (day - 1) * config.efficiencyDayBlockSize + 1;
  const cell = `${getColumnLetter(ordersColumn)}${foundRow}`;

  await updateCell(config.efficiencySheet, cell, ordersCount, spreadsheetId);
  return { ok: true, cell, row: foundRow, day, ordersCount };
}

module.exports = {
  initGoogleSheets,
  findCourierInAllSheets,
  getTodayStatus,
  punchTime,
  prepareMileage,
  replaceTime,
  updateCourierTime,
  updateMileage,
  readCell,
  verifySheetAccess,
  getSheetConfig,
  updateEfficiencyOrders
};
