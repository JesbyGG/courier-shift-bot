const fs = require('fs');
const path = require('path');
const { WORKPLACE_KEY_MAP } = require('../config');
const db = require('../db');

function _getRecord(key) {
  const row = db.prepare('SELECT data FROM users WHERE telegramId = ?').get(String(key));
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (e) {
    return null;
  }
}

function _setRecord(key, data) {
  const stmt = db.prepare('INSERT OR REPLACE INTO users (telegramId, data) VALUES (?, ?)');
  stmt.run(String(key), JSON.stringify(data));
}

function getUserField(telegramId, field) {
  const record = _getRecord(telegramId) || {};
  return record[field] || null;
}

function setUserField(telegramId, field, value) {
  const record = _getRecord(telegramId) || {};
  record[field] = value;
  _setRecord(telegramId, record);
}

function getFullProfile(telegramId) {
  const profile = _getRecord(telegramId) || {};
  return {
    fio: profile.fio || null,
    carNumber: profile.carNumber || null,
    workplace: profile.workplace || null,
    device: profile.device || null,
    role: profile.role || null,
    courierType: profile.courierType || 'auto'
  };
}

function getUserRole(telegramId) {
  const record = _getRecord(telegramId);
  if (!record) return 'courier';
  return record.role || 'courier';
}

function deleteUser(telegramId) {
  db.prepare('DELETE FROM users WHERE telegramId = ?').run(String(telegramId));
}

function getPendingCash(telegramId) {
  const row = db.prepare('SELECT * FROM pending_cash WHERE telegramId = ?').get(String(telegramId));
  if (!row) return null;
  return {
    amount: Number(row.amount || 0),
    formatted: row.formatted || null,
    orders: row.orders || null,
    workplace: row.workplace || null,
    sourceLabel: row.sourceLabel || null,
    confirmationStatus: row.confirmationStatus || null,
    updatedAt: row.updatedAt || null,
    fileId: row.fileId || null
  };
}

function setPendingCash(telegramId, data) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO pending_cash (telegramId, amount, formatted, orders, workplace, sourceLabel, confirmationStatus, updatedAt, fileId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    String(telegramId),
    Number(data?.amount || 0),
    data?.formatted || null,
    data?.orders || null,
    data?.workplace || null,
    data?.sourceLabel || null,
    data?.confirmationStatus || null,
    data?.updatedAt || new Date().toISOString(),
    data?.fileId || null
  );
}

function deletePendingCash(telegramId) {
  db.prepare('DELETE FROM pending_cash WHERE telegramId = ?').run(String(telegramId));
}

function setCashConfirmationStatus(telegramId, status) {
  const row = db.prepare('SELECT * FROM pending_cash WHERE telegramId = ?').get(String(telegramId));
  if (!row) return;
  const stmt = db.prepare(
    'UPDATE pending_cash SET confirmationStatus = ? WHERE telegramId = ?'
  );
  stmt.run(status, String(telegramId));
}

function clearPendingCashAndReminders(telegramId) {
  deletePendingCash(telegramId);
  const allReminders = _getAllReminders();
  for (const reminder of allReminders) {
    if (reminder.courierId === String(telegramId)) {
      _deleteReminder(reminder._shortId);
    }
  }
}

function logCashAction({ logistId, logistFio, courierId, courierFio, workplace, amount, action }) {
  const stmt = db.prepare(
    'INSERT INTO cash_audit (timestamp, logistId, logistFio, courierId, courierFio, workplace, amount, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    new Date().toISOString(),
    logistId || null,
    logistFio || null,
    String(courierId),
    courierFio || null,
    workplace || null,
    amount,
    action
  );
}

function getCashHistory(dateStr, workplace) {
  let sql = "SELECT * FROM cash_audit WHERE DATE(timestamp) = DATE(?)";
  const params = [dateStr];
  if (workplace) {
    sql += " AND workplace = ?";
    params.push(workplace);
  }
  sql += " ORDER BY timestamp ASC";
  return db.prepare(sql).all(...params);
}

function getDebtors(workplace) {
  const rows = db.prepare(
    "SELECT pc.telegramId, pc.amount, pc.formatted, u.data " +
    "FROM pending_cash pc " +
    "JOIN users u ON u.telegramId = pc.telegramId " +
    "WHERE pc.workplace = ? AND pc.amount >= 1"
  ).all(workplace);

  const debtors = [];
  for (const row of rows) {
    let record;
    try {
      record = JSON.parse(row.data);
    } catch (e) {
      continue;
    }
    if (record.role === 'logist') continue;
    debtors.push({
      telegramId: row.telegramId,
      fio: record.fio || 'Неизвестный',
      amount: Number(row.amount || 0),
      formatted: row.formatted || String(row.amount || 0),
      workplace: workplace
    });
  }
  return debtors;
}

function findLogistsForWorkplace(workplace) {
  const ids = getAllUserIds();
  const logists = [];
  for (const id of ids) {
    const record = _getRecord(id);
    if (!record || record.role !== 'logist') continue;
    if (record.workplace !== workplace) continue;
    logists.push({
      telegramId: id,
      fio: record.fio || 'Неизвестный',
      chatId: id
    });
  }
  return logists;
}

function _reminderKey(shortId) {
  return `reminder_${shortId}`;
}

function setReminder(shortId, data) {
  const key = _reminderKey(shortId);
  const stmt = db.prepare('INSERT OR REPLACE INTO states (telegramId, data) VALUES (?, ?)');
  stmt.run(key, JSON.stringify({ ...data, _shortId: shortId }));
}

function getReminder(shortId) {
  const key = _reminderKey(shortId);
  const row = db.prepare('SELECT data FROM states WHERE telegramId = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (e) {
    return null;
  }
}

function updateReminder(shortId, updates) {
  const existing = getReminder(shortId);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  setReminder(shortId, merged);
  return merged;
}

function deleteReminder(shortId) {
  const key = _reminderKey(shortId);
  db.prepare('DELETE FROM states WHERE telegramId = ?').run(key);
}

function _deleteReminder(shortId) {
  deleteReminder(shortId);
}

function _getAllReminders() {
  const rows = db.prepare("SELECT data FROM states WHERE telegramId LIKE 'reminder_%'").all();
  const results = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      results.push(data);
    } catch (e) { /* skip malformed */ }
  }
  return results;
}

function getActiveRemindersForCourier(courierId) {
  return _getAllReminders().filter(r => r.courierId === String(courierId) && r.status !== 'approved' && r.status !== 'declined');
}

function getSelfClearanceRequest(courierId) {
  const pcs = getPendingCash(courierId);
  if (!pcs || pcs.confirmationStatus !== 'awaiting') return null;
  const record = _getRecord(courierId) || {};
  return {
    courierId: String(courierId),
    courierFio: record.fio || 'Неизвестный',
    amount: Number(pcs.amount || 0),
    formatted: pcs.formatted || String(pcs.amount || 0),
    workplace: pcs.workplace || record.workplace || null
  };
}

function cleanupStaleReminders(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const all = _getAllReminders();
  for (const reminder of all) {
    const createdAt = new Date(reminder.createdAt || 0).getTime();
    if (now - createdAt > maxAgeMs) {
      deleteReminder(reminder._shortId);
    }
  }
}

function getAllUserIds() {
  const rows = db.prepare('SELECT telegramId FROM users').all();
  return rows.map(r => r.telegramId).filter(id => /^\d+$/.test(id));
}

const WORKPLACE_SHEETS_KEY = '__workplaceSheets__';
const WORKPLACE_SHEETS_MONTHLY_KEY = '__workplaceSheetsMonthly__';

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

function getWorkplaceMonthlyRoot() {
  return _getRecord(WORKPLACE_SHEETS_MONTHLY_KEY) || {};
}

function getWorkplaceSheetId(workplace) {
  const key = getWorkplaceKey(workplace);
  if (!key) return null;

  const map = _getRecord(WORKPLACE_SHEETS_KEY) || {};
  return map[key] || null;
}

function setWorkplaceSheetId(workplace, sheetId) {
  const key = getWorkplaceKey(workplace);
  if (!key) return;

  const map = _getRecord(WORKPLACE_SHEETS_KEY) || {};
  if (sheetId) {
    map[key] = sheetId;
  } else {
    delete map[key];
  }
  _setRecord(WORKPLACE_SHEETS_KEY, map);
}

function getWorkplaceMonthMap(workplace) {
  const key = getWorkplaceKey(workplace);
  if (!key) return {};

  const monthlyRoot = getWorkplaceMonthlyRoot();
  return { ...(monthlyRoot[key] || {}) };
}

function getWorkplaceSheetIdByMonth(workplace, monthKey) {
  if (!isValidMonthKey(monthKey)) return null;

  const key = getWorkplaceKey(workplace);
  if (!key) return null;

  const monthlyRoot = getWorkplaceMonthlyRoot();
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

  const monthlyRoot = getWorkplaceMonthlyRoot();
  if (!monthlyRoot[key]) monthlyRoot[key] = {};

  if (sheetId) {
    monthlyRoot[key][monthKey] = sheetId;
  } else {
    delete monthlyRoot[key][monthKey];
  }
  
  _setRecord(WORKPLACE_SHEETS_MONTHLY_KEY, monthlyRoot);
}

function resolveSheetInfo(workplace, options = {}) {
  const { monthKey = null } = options;
  const currentMonthKey = getCurrentMonthKey();
  
  const targetMonthKey = monthKey || currentMonthKey;
  let sheetId = getWorkplaceSheetIdByMonth(workplace, targetMonthKey);
  
  if (sheetId) {
    return { sheetId, isMonthly: true, monthKey: targetMonthKey };
  }

  const fallbackSheetId = getWorkplaceSheetId(workplace);
  if (fallbackSheetId) {
    return { sheetId: fallbackSheetId, isMonthly: false, monthKey: null };
  }

  return { sheetId: null, isMonthly: false, monthKey: null };
}

function cleanupOldMonths(retentionMonths = 3) {
  if (!Number.isFinite(retentionMonths) || retentionMonths < 1) return;

  const monthlyRoot = getWorkplaceMonthlyRoot();
  const currentMonthKey = getCurrentMonthKey();
  const [cyStr, cmStr] = currentMonthKey.split('-');
  const cy = Number(cyStr);
  const cm = Number(cmStr);

  let hasChanges = false;

  for (const wpKey of Object.keys(monthlyRoot)) {
    const monthKeys = Object.keys(monthlyRoot[wpKey]);
    for (const mk of monthKeys) {
      if (!isValidMonthKey(mk)) continue;
      const [yStr, mStr] = mk.split('-');
      const y = Number(yStr);
      const m = Number(mStr);
      const diff = (cy - y) * 12 + (cm - m);
      if (diff > retentionMonths) {
        delete monthlyRoot[wpKey][mk];
        hasChanges = true;
      }
    }
  }

  if (hasChanges) {
    _setRecord(WORKPLACE_SHEETS_MONTHLY_KEY, monthlyRoot);
  }
}

const SHEET_ACCESS_USERS = '__sheetAccessUsers__';

function getSheetAccessUsers() {
  const list = _getRecord(SHEET_ACCESS_USERS) || [];
  return Array.isArray(list) ? list : [];
}

function addSheetAccessUser(telegramId) {
  const users = getSheetAccessUsers();
  if (!users.includes(String(telegramId))) {
    users.push(String(telegramId));
    _setRecord(SHEET_ACCESS_USERS, users);
  }
}

function removeSheetAccessUser(telegramId) {
  let users = getSheetAccessUsers();
  users = users.filter((id) => id !== String(telegramId));
  _setRecord(SHEET_ACCESS_USERS, users);
}

function isSheetAccessUser(telegramId) {
  const list = getSheetAccessUsers();
  return list.includes(String(telegramId));
}

function markUserSeen(telegramId) {
  const record = _getRecord(telegramId) || {};
  record.lastSeen = new Date().toISOString();
  _setRecord(telegramId, record);
}

module.exports = {
  getUserField,
  setUserField,
  getFullProfile,
  getUserRole,
  deleteUser,
  getPendingCash,
  setPendingCash,
  deletePendingCash,
  setCashConfirmationStatus,
  clearPendingCashAndReminders,
  getAllUserIds,

  resolveSheetInfo,
  getWorkplaceSheetId,
  setWorkplaceSheetId,
  getWorkplaceMonthMap,
  getWorkplaceSheetIdByMonth,
  setWorkplaceSheetIdByMonth,
  getCurrentMonthKey,
  getNextMonthKey,
  isValidMonthKey,

  getSheetAccessUsers,
  addSheetAccessUser,
  removeSheetAccessUser,
  isSheetAccessUser,

  markUserSeen,
  cleanupOldMonths,

  logCashAction,
  getCashHistory,
  getDebtors,
  findLogistsForWorkplace,
  setReminder,
  getReminder,
  updateReminder,
  deleteReminder,
  getActiveRemindersForCourier,
  getSelfClearanceRequest,
  cleanupStaleReminders
};