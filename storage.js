const fs = require('fs');
const path = require('path');
const { WORKPLACE_KEY_MAP } = require('./config');

const storagePath = path.join(__dirname, 'users.json');

let cache = null;
let writeScheduled = false;

function loadStorage() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(storagePath)) {
      cache = {};
      return cache;
    }
    cache = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    return cache;
  } catch (error) {
    console.error('storage load error', error);
    // Защита от потери данных: если JSON битый — переименовываем файл,
    // не затираем пустотой. Так пользователь/админ может восстановить вручную.
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const broken = `${storagePath}.broken-${ts}`;
      fs.renameSync(storagePath, broken);
      console.error(`corrupted storage saved to ${broken}`);
    } catch (renameError) {
      console.error('failed to preserve corrupted storage', renameError.message);
    }
    cache = {};
    return cache;
  }
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function scheduleWrite() {
  if (writeScheduled) return;
  writeScheduled = true;
  setImmediate(() => {
    writeScheduled = false;
    try {
      atomicWrite(storagePath, JSON.stringify(cache, null, 2));
    } catch (error) {
      console.error('storage write error', error);
    }
  });
}

function flushNow() {
  writeScheduled = false;
  try {
    atomicWrite(storagePath, JSON.stringify(cache || {}, null, 2));
  } catch (error) {
    console.error('storage flush error', error);
  }
}

function getUserField(telegramId, field) {
  const storage = loadStorage();
  return storage[String(telegramId)]?.[field] || null;
}

function setUserField(telegramId, field, value) {
  const key = String(telegramId);
  cache = loadStorage();
  cache[key] = { ...cache[key], [field]: value };
  scheduleWrite();
}

function getFullProfile(telegramId) {
  const profile = loadStorage()[String(telegramId)] || {};
  return {
    fio: profile.fio || null,
    carNumber: profile.carNumber || null,
    workplace: profile.workplace || null,
    device: profile.device || null
  };
}

function deleteUser(telegramId) {
  cache = loadStorage();
  delete cache[String(telegramId)];
  scheduleWrite();
}

function clearPendingCashToSubmit(telegramId) {
  const key = String(telegramId);
  cache = loadStorage();

  if (cache[key]) {
    delete cache[key].pendingCashToSubmit;
  }

  scheduleWrite();
}

function getAllUserIds() {
  const storage = loadStorage();
  return Object.keys(storage).filter((key) => /^\d+$/.test(key));
}

const WORKPLACE_SHEETS_KEY = '__workplaceSheets__';
const WORKPLACE_SHEETS_MONTHLY_KEY = '__workplaceSheetsMonthly__';
// WORKPLACE_KEY_MAP — теперь в config.js (см. импорт выше)

function getWorkplaceKey(workplace) {
  return WORKPLACE_KEY_MAP[workplace] || null;
}

function getCurrentMonthKey(timezone = process.env.APP_TIMEZONE || 'Europe/Moscow') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function getNextMonthKey(timezone = process.env.APP_TIMEZONE || 'Europe/Moscow') {
  const currentKey = getCurrentMonthKey(timezone);
  const [yearText, monthText] = currentKey.split('-');
  let year = Number(yearText);
  let month = Number(monthText) + 1;

  if (month > 12) {
    month = 1;
    year += 1;
  }

  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

function isValidMonthKey(monthKey) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey || '').trim());
}

function getWorkplaceMonthlyRoot(storage) {
  return storage[WORKPLACE_SHEETS_MONTHLY_KEY] || {};
}

function getWorkplaceSheetId(workplace) {
  const key = getWorkplaceKey(workplace);
  if (!key) return null;

  const storage = loadStorage();
  const map = storage[WORKPLACE_SHEETS_KEY] || {};
  return map[key] || null;
}

function setWorkplaceSheetId(workplace, sheetId) {
  const key = getWorkplaceKey(workplace);
  if (!key) return;

  cache = loadStorage();
  if (!cache[WORKPLACE_SHEETS_KEY]) cache[WORKPLACE_SHEETS_KEY] = {};
  if (sheetId) {
    cache[WORKPLACE_SHEETS_KEY][key] = sheetId;
  } else {
    delete cache[WORKPLACE_SHEETS_KEY][key];
  }
  scheduleWrite();
}

function getWorkplaceMonthMap(workplace) {
  const key = getWorkplaceKey(workplace);
  if (!key) return {};

  const storage = loadStorage();
  const monthlyRoot = getWorkplaceMonthlyRoot(storage);
  const map = monthlyRoot[key] || {};
  return { ...map };
}

function getWorkplaceSheetIdByMonth(workplace, monthKey) {
  if (!isValidMonthKey(monthKey)) return null;

  const key = getWorkplaceKey(workplace);
  if (!key) return null;

  const storage = loadStorage();
  const monthlyRoot = getWorkplaceMonthlyRoot(storage);
  return monthlyRoot[key]?.[monthKey] || null;
}

function setWorkplaceSheetIdByMonth(workplace, monthKey, sheetId) {
  if (!isValidMonthKey(monthKey)) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }

  const key = getWorkplaceKey(workplace);
  if (!key) {
    throw new Error(`Unknown workplace: ${workplace}`);
  }

  cache = loadStorage();
  if (!cache[WORKPLACE_SHEETS_MONTHLY_KEY]) cache[WORKPLACE_SHEETS_MONTHLY_KEY] = {};
  if (!cache[WORKPLACE_SHEETS_MONTHLY_KEY][key]) cache[WORKPLACE_SHEETS_MONTHLY_KEY][key] = {};

  if (sheetId) {
    cache[WORKPLACE_SHEETS_MONTHLY_KEY][key][monthKey] = sheetId;
  } else {
    delete cache[WORKPLACE_SHEETS_MONTHLY_KEY][key][monthKey];
  }

  scheduleWrite();
}

function resolveSheetInfo(workplace, options = {}) {
  const monthKey = options.monthKey && isValidMonthKey(options.monthKey)
    ? options.monthKey
    : getCurrentMonthKey(options.timezone);

  const monthlyMap = getWorkplaceMonthMap(workplace);
  const hasMonthlyMap = Object.keys(monthlyMap).length > 0;

  if (hasMonthlyMap) {
    const monthSheetId = monthlyMap[monthKey] || null;
    if (monthSheetId) {
      return {
        sheetId: monthSheetId,
        source: 'monthly',
        monthKey,
        hasMonthlyMap,
        missingForMonth: false,
        noSheetForMonth: false
      };
    }

    return {
      sheetId: null,
      source: 'monthly',
      monthKey,
      hasMonthlyMap,
      missingForMonth: true,
      noSheetForMonth: true
    };
  }

  const legacySheetId = getWorkplaceSheetId(workplace);
  if (legacySheetId) {
    return {
      sheetId: legacySheetId,
      source: 'legacy',
      monthKey,
      hasMonthlyMap,
      missingForMonth: false,
      noSheetForMonth: false
    };
  }

  if (options.allowFallback !== false) {
    const fallbackSheetId = getFallbackSheetId();
    if (fallbackSheetId) {
      return {
        sheetId: fallbackSheetId,
        source: 'fallback',
        monthKey,
        hasMonthlyMap,
        missingForMonth: false,
        noSheetForMonth: false
      };
    }
  }

  return {
    sheetId: null,
    source: 'none',
    monthKey,
    hasMonthlyMap,
    missingForMonth: false,
    noSheetForMonth: false
  };
}

function getFallbackSheetId() {
  return process.env.GOOGLE_SHEET_ID || null;
}

function getSheetAccessUsers() {
  // Защита от NPE: гарантируем, что cache загружен, даже если функцию
  // вызвали раньше любой другой storage-операции.
  loadStorage();
  return (cache._sheetAccessUsers || []);
}

function addSheetAccessUser(telegramId) {
  cache = loadStorage();
  const id = Number(telegramId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const users = cache._sheetAccessUsers || [];
  if (users.includes(id)) return false;
  cache._sheetAccessUsers = [...users, id];
  scheduleWrite();
  return true;
}

function removeSheetAccessUser(telegramId) {
  cache = loadStorage();
  const id = Number(telegramId);
  const users = cache._sheetAccessUsers || [];
  const index = users.indexOf(id);
  if (index === -1) return false;
  cache._sheetAccessUsers = users.filter(u => u !== id);
  scheduleWrite();
  return true;
}

function isSheetAccessUser(telegramId) {
  const users = getSheetAccessUsers();
  return users.includes(Number(telegramId));
}

function isNewUser(telegramId) {
  const storage = loadStorage();
  const key = String(telegramId);
  const profile = storage[key];
  if (!profile) return true;
  return !profile.fio && !profile.workplace;
}

function markUserSeen(telegramId) {
  const storage = loadStorage();
  const key = String(telegramId);
  if (!storage[key]) {
    storage[key] = {};
  }
  if (!storage[key]._seen) {
    storage[key]._seen = true;
    scheduleWrite();
    return true;
  }
  return false;
}

function cleanupOldMonths() {
  const currentMonth = getCurrentMonthKey();
  const nextMonth = getNextMonthKey();
  const keepMonths = new Set([currentMonth, nextMonth]);
  const storage = loadStorage();
  const monthlyRoot = storage[WORKPLACE_SHEETS_MONTHLY_KEY];
  if (!monthlyRoot) return 0;

  let removed = 0;
  for (const key of Object.keys(monthlyRoot)) {
    for (const monthKey of Object.keys(monthlyRoot[key])) {
      if (!keepMonths.has(monthKey)) {
        delete monthlyRoot[key][monthKey];
        removed++;
      }
    }
  }

  if (removed > 0) {
    scheduleWrite();
  }
  return removed;
}

module.exports = {
  getUserField,
  setUserField,
  getFullProfile,
  deleteUser,
  clearPendingCashToSubmit,
  getAllUserIds,
  getCurrentMonthKey,
  getNextMonthKey,
  isValidMonthKey,
  setWorkplaceSheetId,
  getWorkplaceMonthMap,
  getWorkplaceSheetIdByMonth,
  setWorkplaceSheetIdByMonth,
  getFallbackSheetId,
  resolveSheetInfo,
  getSheetAccessUsers,
  addSheetAccessUser,
  removeSheetAccessUser,
  isSheetAccessUser,
  markUserSeen,
  cleanupOldMonths,
  flushNow
};
