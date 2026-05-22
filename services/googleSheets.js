const { JWT } = require('google-auth-library');
const {
  normalizeFio,
  normalizeFioWords,
  getColumnLetter,
  getCourierColumnsByDay,
  getMileageColumnsByDay,
  roundTimeToHalfHour,
  getCurrentDateInfo,
  isEmptyCell,
  isScheduleMarker
} = require('../utils');
const db = require('../db');
// WORKPLACES в этом файле не нужны напрямую — SHEET_CONFIGS использует
// строковые ключи и DEFAULT_CONFIG. Если позже понадобится — импортируем.

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let sheetsAuth;
let notifyAdminCallback = null;

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

// --- In-memory cache for row lookups ---
let rowCache = {};
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- Batch update queue ---
let pendingUpdates = [];
let updateTimer = null;

function setNotifyAdminCallback(cb) {
  notifyAdminCallback = cb;
}

function loadPendingUpdatesFromDb() {
  try {
    const rows = db.prepare('SELECT id, spreadsheetId, range, value FROM pending_sheet_updates').all();
    for (const row of rows) {
      pendingUpdates.push({
        _dbId: row.id,
        spreadsheetId: row.spreadsheetId,
        range: row.range,
        values: [[row.value]]
      });
    }
    if (rows.length > 0) {
      console.log(`restored ${rows.length} pending sheet update(s) from db`);
    }
  } catch (e) {
    console.error('failed to load pending sheet updates from db', e.message);
  }
}

function savePendingUpdateToDb(spreadsheetId, range, value) {
  try {
    const stmt = db.prepare('INSERT INTO pending_sheet_updates (spreadsheetId, range, value) VALUES (?, ?, ?)');
    const result = stmt.run(spreadsheetId, range, String(value));
    return result.lastInsertRowid;
  } catch (e) {
    console.error('failed to save pending sheet update to db', e.message);
    return null;
  }
}

function deletePendingUpdatesFromDb(ids) {
  if (!ids || ids.length === 0) return;
  try {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM pending_sheet_updates WHERE id IN (${placeholders})`).run(...ids);
  } catch (e) {
    console.error('failed to delete pending sheet updates from db', e.message);
  }
}

async function sheetsRequest({ method, path, params, data }, retries = 3) {
  const auth = getSheetsAuth();
  const url = `${SHEETS_BASE}/${path}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await auth.request({ method, url, params, data });
      return response;
    } catch (error) {
      const status = error?.response?.status || 0;
      const retryable = status === 429 || status >= 500 || status === 0;

      if (!retryable || attempt === retries) {
        throw error;
      }

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.error(`Google Sheets retry ${attempt}/${retries} (status=${status}), waiting ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
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
    efficiencyFirstDayCol: 6,
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
    efficiencyFirstDayCol: 6,
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

  const range = `${quoteSheetName(sheetName)}!${cell}`;
  const dbId = savePendingUpdateToDb(spreadsheetId, range, value);

  pendingUpdates.push({
    _dbId: dbId,
    spreadsheetId,
    range,
    values: [[value]]
  });

  if (!updateTimer) {
    updateTimer = setTimeout(flushSheetUpdates, 3000);
  }
}

async function flushSheetUpdates() {
  if (pendingUpdates.length === 0) return;
  const dataToUpdate = [...pendingUpdates];
  pendingUpdates = [];
  updateTimer = null;

  // Group by spreadsheetId because batchUpdate is per-sheet
  const bySheet = {};
  const dbIds = [];
  for (const item of dataToUpdate) {
    if (!bySheet[item.spreadsheetId]) bySheet[item.spreadsheetId] = [];
    bySheet[item.spreadsheetId].push({ range: item.range, values: item.values });
    if (item._dbId) dbIds.push(item._dbId);
  }

  let hadError = false;
  let errorMessage = '';

  for (const [spreadsheetId, data] of Object.entries(bySheet)) {
    try {
      await sheetsRequest({
        method: 'POST',
        path: `${spreadsheetId}/values:batchUpdate`,
        data: {
          valueInputOption: 'USER_ENTERED',
          data
        }
      });
    } catch (error) {
      hadError = true;
      errorMessage = error.message || String(error);
      console.error('Ошибка Batch Update Google Sheets:', errorMessage);
    }
  }

  if (!hadError) {
    deletePendingUpdatesFromDb(dbIds);
  } else {
    // Notify admins about critical failure
    if (notifyAdminCallback) {
      try {
        notifyAdminCallback(`⚠️ <b>Критическая ошибка Google Sheets</b>\n\nBatch update не удалось: <code>${errorMessage}</code>\n\n${dbIds.length} запись(ей) останется в очереди и будет повторена при следующем запуске.`);
      } catch (e) {
        console.error('failed to notify admins about sheets error', e.message);
      }
    }
  }
}

async function findCourierByFio(fio, workplace, sheetContext = null) {
  const context = sheetContext || resolveSheetContext(workplace);
  const spreadsheetId = context.sheetId;
  if (!spreadsheetId) return null;

  const config = getSheetConfig(workplace);
  const target = normalizeFioWords(fio);
  const cacheKey = `${spreadsheetId}:courier:${target}`;

  if (Date.now() - cacheTimestamp < CACHE_TTL && rowCache[cacheKey]) {
    return rowCache[cacheKey];
  }

  const rows = await getValues(`${quoteSheetName(config.courierSheet)}!${config.courierFioRange}`, spreadsheetId);

  // Rebuild cache for this sheet
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowFio = getRowValueByColumn(row, config.courierFioRange, config.courierFioColumn) || row[row.length - 1] || '';
    const normalized = normalizeFioWords(rowFio);
    if (normalized) {
      rowCache[`${spreadsheetId}:courier:${normalized}`] = { row: index + 3, fio: rowFio, auto: row[0] || '', spreadsheetId };
    }
  }
  cacheTimestamp = Date.now();

  return rowCache[cacheKey] || null;
}

async function findMileageByFio(fio, workplace, sheetContext = null) {
  const context = sheetContext || resolveSheetContext(workplace);
  const spreadsheetId = context.sheetId;
  if (!spreadsheetId) return null;

  const config = getSheetConfig(workplace);
  const target = normalizeFioWords(fio);
  const cacheKey = `${spreadsheetId}:mileage:${target}`;

  if (Date.now() - cacheTimestamp < CACHE_TTL && rowCache[cacheKey]) {
    return rowCache[cacheKey];
  }

  const rows = await getValues(`${quoteSheetName(config.mileageSheet)}!${config.mileageFioRange}`, spreadsheetId);

  // Rebuild cache for this sheet
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowFio = getRowValueByColumn(row, config.mileageFioRange, config.mileageFioColumn) || row[row.length - 1] || '';
    const auto = getRowValueByColumn(row, config.mileageFioRange, config.mileageAutoColumn) || row[0] || '';
    const normalized = normalizeFioWords(rowFio);
    if (normalized) {
      rowCache[`${spreadsheetId}:mileage:${normalized}`] = { row: index + 3, fio: rowFio, auto, spreadsheetId };
    }
  }
  cacheTimestamp = Date.now();

  return rowCache[cacheKey] || null;
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
      const target = normalizeFioWords(fio);

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const rowFio = getRowValueByColumn(row, config.courierFioRange, config.courierFioColumn) || row[row.length - 1] || '';

        if (normalizeFioWords(rowFio) === target) {
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
    auto: courier.auto || (mileage ? mileage.auto : ''),
    date: dateText,
    day,
    stage,
    courierRow: courier.row,
    mileageRow: mileage ? mileage.row : null,
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

async function resolveCourierContext(fio, workplace, options = {}) {
  const { requireMileage = true } = options;
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
  const courier = await findCourierByFio(fio, workplace, sheetContext);

  if (!courier) {
    return { sheetContext, spreadsheetId, config, courier: null, mileage: null, notFound: true };
  }

  if (!requireMileage) {
    return { sheetContext, spreadsheetId, config, courier, mileage: null, notFound: false };
  }

  const mileage = await findMileageByFio(fio, workplace, sheetContext);

  if (!mileage) {
    return { sheetContext, spreadsheetId, config, courier, mileage: null, notFound: true };
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

async function punchTime(fio, workplace, isPedestrian = false) {
  const ctx = await resolveCourierContext(fio, workplace, { requireMileage: !isPedestrian });
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

  const [from, to] = await Promise.all([
    readCell(config.courierSheet, startCell, spreadsheetId),
    readCell(config.courierSheet, endCell, spreadsheetId)
  ]);

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
    auto: courier.auto || (mileage ? mileage.auto : ''),
    date: dateText,
    day,
    courierRow: courier.row,
    mileageRow: mileage ? mileage.row : null,
    timeValue,
    from,
    to
  };
}

async function replaceTime(fio, workplace, stage, isPedestrian = false) {
  const ctx = await resolveCourierContext(fio, workplace, { requireMileage: !isPedestrian });
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
  return updateCell(config.courierSheet, cell, value, spreadsheetId);
}

async function updateMileage(row, day, stage, mileage, workplace) {
  const { spreadsheetId, config } = requireSheetId(workplace);
  const columns = getMileageColumns(workplace, day);
  const columnNumber = stage === 'start' ? columns.startColumn : columns.endColumn;
  const cell = `${getColumnLetter(columnNumber)}${row}`;
  return updateCell(config.mileageSheet, cell, String(mileage), spreadsheetId);
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
  updateEfficiencyOrders,
  loadPendingUpdatesFromDb,
  setNotifyAdminCallback
};
