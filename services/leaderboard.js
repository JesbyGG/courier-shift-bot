const db = require('../db');

function flushNow() {
  // SQLite WAL is persistent.
}

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

function recordOrders(telegramId, fio, workplace, ordersCount) {
  let record = _getRecord(telegramId);
  if (!record) {
    record = {
      fio,
      workplace,
      dailyOrders: {}
    };
  }

  record.fio = fio || record.fio;
  record.workplace = workplace || record.workplace;

  const dayKey = getTodayKey();
  record.dailyOrders[dayKey] = ordersCount;

  _setRecord(telegramId, record);
  return record;
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

function calculateLeaderboard(type, periodDays, workplace) {
  const records = _getAllRecords();
  const cutoff = periodDays ? getDaysAgo(periodDays) : null;
  
  const wpMapping = { east: 'ИМ Восток', center: 'ИМ Центр' };
  const filterWorkplace = workplace && workplace !== 'all' ? (wpMapping[workplace] || workplace) : null;

  const entries = [];
  for (const [telegramId, record] of Object.entries(records)) {
    if (!record.dailyOrders) continue;
    if (filterWorkplace && record.workplace !== filterWorkplace) continue;

    let value = 0;
    for (const [dayKey, orders] of Object.entries(record.dailyOrders)) {
      if (cutoff && dayKey < cutoff) continue;
      if (type === 'max') {
        if (orders > value) value = orders;
      } else {
        value += orders;
      }
    }

    if (value > 0) {
      entries.push({
        telegramId,
        fio: record.fio || 'Неизвестный',
        workplace: record.workplace || '',
        value
      });
    }
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
    if (entry.rank === 1) medal = '🥇';
    else if (entry.rank === 2) medal = '🥈';
    else if (entry.rank === 3) medal = '🥉';
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
  const record = _getRecord(telegramId);
  const previousRecord = record ? record.personalRecord : 0;
  
  if (currentDayOrders > (previousRecord || 0)) {
    if (record) {
      record.personalRecord = currentDayOrders;
      _setRecord(telegramId, record);
    }
    if (previousRecord && previousRecord > 0) {
      return [{ type: 'personal_record', value: currentDayOrders, previous: previousRecord }];
    }
  }
  return [];
}

function getDayOrders(telegramId, dayKey) {
  const record = _getRecord(telegramId);
  if (!record || !record.dailyOrders) return 0;
  return record.dailyOrders[dayKey] || 0;
}

function findOvertakenCouriers(telegramId, workplace, oldOrders, newOrders, dayKey) {
  if (oldOrders <= 0 || newOrders <= oldOrders) return [];
  const records = _getAllRecords();
  const overtaken = [];
  for (const [tid, record] of Object.entries(records)) {
    if (tid === String(telegramId)) continue;
    if (record.workplace !== workplace) continue;
    if (!record.dailyOrders) continue;
    const theirOrders = record.dailyOrders[dayKey] || 0;
    if (theirOrders > oldOrders && theirOrders < newOrders) {
      overtaken.push({
        telegramId: tid,
        fio: record.fio || 'Неизвестный',
        orders: theirOrders
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
  flushNow,
  getDayOrders,
  findOvertakenCouriers,
  getTodayKey
};