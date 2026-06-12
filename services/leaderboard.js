const db = require('../db');
const { pe } = require('./premiumEmoji');

function _getRecord(telegramId) {
  const row = db.prepare('SELECT data FROM leaderboard WHERE telegramId = ?').get(String(telegramId));
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function _setRecord(telegramId, data) {
  const stmt = db.prepare('INSERT OR REPLACE INTO leaderboard (telegramId, data) VALUES (?, ?)');
  stmt.run(String(telegramId), JSON.stringify(data));
}

function _getAllRecords() {
  const rows = db.prepare('SELECT telegramId, data FROM leaderboard').all();
  const records = {};
  for (const row of rows) {
    try {
      records[row.telegramId] = JSON.parse(row.data);
    } catch {
      // ignore bad JSON
    }
  }
  return records;
}

function _formatLocalDate(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

function getTodayKey() {
  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  return _formatLocalDate(new Date(), timezone);
}

function recordOrders(telegramId, fio, workplace, ordersCount, courierType) {
  let record = _getRecord(telegramId);
  if (!record) {
    record = {
      fio,
      workplace,
      courierType,
      dailyOrders: {}
    };
  }

  record.fio = fio || record.fio;
  record.workplace = workplace || record.workplace;
  if (courierType) {
    record.courierType = courierType;
  }

  const dayKey = getTodayKey();
  record.dailyOrders[dayKey] = ordersCount;

  _setRecord(telegramId, record);

  const stmt = db.prepare(`
    INSERT INTO daily_orders (telegramId, date, orders)
    VALUES (?, ?, ?)
    ON CONFLICT(telegramId, date) DO UPDATE SET orders = ?
  `);
  stmt.run(String(telegramId), dayKey, ordersCount, ordersCount);

  return record;
}

function getTodayDate() {
  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  return _formatLocalDate(new Date(), timezone);
}

function getDaysAgo(days) {
  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const msPerDay = 24 * 60 * 60 * 1000;
  const pastDate = new Date(Date.now() - days * msPerDay);
  return _formatLocalDate(pastDate, timezone);
}

const WORKPLACE_SHORT = {
  'ИМ Восток': 'Восток',
  'ИМ Центр': 'Центр'
};

function calculateLeaderboard(type, periodDays, workplace, courierTypeFilter) {
  let cutoff = null;
  if (periodDays === 1) {
    cutoff = getTodayDate();
  } else if (periodDays) {
    cutoff = getDaysAgo(periodDays);
  }

  const wpMapping = { east: 'ИМ Восток', center: 'ИМ Центр' };
  const filterWorkplace = workplace && workplace !== 'all' ? (wpMapping[workplace] || workplace) : null;

  let sql = '';
  const params = [];
  if (type === 'max') {
    sql = 'SELECT telegramId, MAX(orders) as value FROM daily_orders';
  } else {
    sql = 'SELECT telegramId, SUM(orders) as value FROM daily_orders';
  }

  if (cutoff) {
    if (periodDays === 1) {
      sql += ' WHERE date = ?';
    } else {
      sql += ' WHERE date >= ?';
    }
    params.push(cutoff);
  }

  sql += ' GROUP BY telegramId HAVING value > 0';

  const rows = db.prepare(sql).all(...params);
  const records = _getAllRecords();

  const entries = [];
  for (const row of rows) {
    const record = records[row.telegramId];
    if (!record) continue;
    if (filterWorkplace && record.workplace !== filterWorkplace) continue;
    if (courierTypeFilter && courierTypeFilter !== 'all' && record.courierType !== courierTypeFilter) continue;

    entries.push({
      telegramId: row.telegramId,
      fio: record.fio || 'Неизвестный',
      workplace: record.workplace || '',
      courierType: record.courierType || 'auto',
      value: row.value
    });
  }

  entries.sort((a, b) => b.value - a.value || a.fio.localeCompare(b.fio, 'ru'));

  let rank = 1;
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && entries[i].value < entries[i - 1].value) {
      rank = i + 1;
    }
    entries[i].rank = rank;
  }

  return entries;
}

function formatLeaderboard(entries, myTelegramId, showWorkplace = false) {
  if (entries.length === 0) {
    return 'Пока пусто.';
  }

  const lines = entries.slice(0, 50).map(entry => {
    let medal = '';
    if (entry.rank === 1) medal = pe('🥇');
    else if (entry.rank === 2) medal = pe('🥈');
    else if (entry.rank === 3) medal = pe('🥉');
    else medal = '  ';

    let fioStr = entry.fio.split(' ').slice(0, 2).join(' ');
    if (entry.telegramId === String(myTelegramId)) {
      fioStr = `<b>${fioStr} (Вы)</b>`;
    }

    let wpSuffix = '';
    if (showWorkplace && entry.workplace) {
      const short = WORKPLACE_SHORT[entry.workplace] || entry.workplace.replace('ИМ ', '');
      wpSuffix = ` [${short}]`;
    }

    return `${medal} ${entry.rank}. ${fioStr}${wpSuffix} — <b>${entry.value}</b>`;
  });

  const myIndex = entries.findIndex(e => e.telegramId === String(myTelegramId));
  if (myIndex >= 50) {
    lines.push('...');
    const myEntry = entries[myIndex];
    let wpSuffix = '';
    if (showWorkplace && myEntry.workplace) {
      const short = WORKPLACE_SHORT[myEntry.workplace] || myEntry.workplace.replace('ИМ ', '');
      wpSuffix = ` [${short}]`;
    }
    lines.push(`   ${myEntry.rank}. <b>${myEntry.fio.split(' ').slice(0, 2).join(' ')} (Вы)</b>${wpSuffix} — <b>${myEntry.value}</b>`);
  }

  return lines.join('\n');
}

function checkNotifications(telegramId, fio, workplace, currentDayOrders) {
  let record = _getRecord(telegramId);
  const previousRecord = record ? record.personalRecord : 0;
  
  if (currentDayOrders > (previousRecord || 0)) {
    if (!record) {
      record = { fio, workplace, dailyOrders: {} };
    }
    record.personalRecord = currentDayOrders;
    _setRecord(telegramId, record);
    return [{ type: 'personal_record', value: currentDayOrders, previous: previousRecord || 0 }];
  }
  return [];
}

function getDayOrders(telegramId, dayKey) {
  const row = db.prepare('SELECT orders FROM daily_orders WHERE telegramId = ? AND date = ?').get(String(telegramId), dayKey);
  return row && row.orders ? row.orders : 0;
}

function getWorkplaceRecord(workplace, dayKey) {
  const root = _getRecord('__workplaceRecords__') || {};
  return root[workplace]?.[dayKey] || null;
}

function setWorkplaceRecord(workplace, dayKey, orders, fio) {
  const root = _getRecord('__workplaceRecords__') || {};
  if (!root[workplace]) root[workplace] = {};
  root[workplace][dayKey] = { orders, fio, at: new Date().toISOString() };
  _setRecord('__workplaceRecords__', root);
  return root[workplace][dayKey];
}

function getDailyTop3(workplace, dayKey) {
  const rows = db.prepare('SELECT telegramId, orders FROM daily_orders WHERE date = ?').all(dayKey);
  const records = _getAllRecords();
  const entries = [];
  for (const row of rows) {
    const record = records[row.telegramId];
    if (!record || record.workplace !== workplace) continue;
    entries.push({
      telegramId: row.telegramId,
      fio: record.fio || 'Неизвестный',
      orders: row.orders
    });
  }
  entries.sort((a, b) => b.orders - a.orders);
  for (let i = 0; i < entries.length; i++) {
    entries[i].rank = i + 1;
  }
  return entries.slice(0, 3);
}

function findOvertakenCouriers(telegramId, workplace, oldOrders, newOrders, dayKey) {
  if (newOrders <= oldOrders) return [];
  const rows = db.prepare('SELECT telegramId, orders FROM daily_orders WHERE date = ? AND telegramId != ?').all(dayKey, String(telegramId));
  const records = _getAllRecords();
  const overtaken = [];
  for (const row of rows) {
    const record = records[row.telegramId];
    if (!record || record.workplace !== workplace) continue;
    if (row.orders > oldOrders && row.orders < newOrders) {
      overtaken.push({
        telegramId: row.telegramId,
        fio: record.fio || 'Неизвестный',
        orders: row.orders
      });
    }
  }
  overtaken.sort((a, b) => b.orders - a.orders);
  return overtaken;
}

module.exports = {
  recordOrders,
  calculateLeaderboard,
  formatLeaderboard,
  checkNotifications,
  getDayOrders,
  getWorkplaceRecord,
  setWorkplaceRecord,
  getDailyTop3,
  findOvertakenCouriers,
  getTodayKey,
  _getAllRecords
};