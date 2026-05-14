const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'leaderboard-cache.json');

let _cache = null;
let _writeScheduled = false;

function loadCache() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } else {
      _cache = { records: {} };
    }
  } catch {
    _cache = { records: {} };
  }
  return _cache;
}

function scheduleWrite() {
  if (_writeScheduled) return;
  _writeScheduled = true;
  setImmediate(() => {
    _writeScheduled = false;
    try {
      const tmp = CACHE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_PATH);
    } catch (err) {
      console.error('leaderboard cache write error', err.message);
    }
  });
}

function flushNow() {
  _writeScheduled = false;
  try {
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_cache || loadCache(), null, 2), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.error('leaderboard cache flush error', err.message);
  }
}

function getTodayKey() {
  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const now = new Date();
  const offset = timezone === 'Europe/Moscow' ? 3 : -(now.getTimezoneOffset() / 60);
  const local = new Date(now.getTime() + offset * 3600000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function recordOrders(telegramId, fio, workplace, ordersCount) {
  const cache = loadCache();

  if (!cache.records[telegramId]) {
    cache.records[telegramId] = {
      fio,
      workplace,
      dailyOrders: {}
    };
  }

  const record = cache.records[telegramId];
  record.fio = fio || record.fio;
  record.workplace = workplace || record.workplace;

  const dayKey = getTodayKey();
  record.dailyOrders[dayKey] = ordersCount;

  scheduleWrite();
  return record;
}

function getDaysAgo(days) {
  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const now = new Date();
  const offset = timezone === 'Europe/Moscow' ? 3 : -(now.getTimezoneOffset() / 60);
  const local = new Date(now.getTime() + offset * 3600000);
  local.setUTCDate(local.getUTCDate() - days);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const WORKPLACE_SHORT = {
  'ИМ Восток': 'Восток',
  'ИМ Центр': 'Центр'
};

function calculateLeaderboard(type, periodDays, workplace) {
  const cache = loadCache();
  const records = cache.records || {};
  const cutoff = periodDays ? getDaysAgo(periodDays) : null;
  const filterWorkplace = workplace && workplace !== 'all' ? workplace : null;

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

function formatLeaderboard(entries, myTelegramId, showWorkplace) {
  const top = entries.slice(0, 10);
  const me = entries.find((e) => e.telegramId === String(myTelegramId));

  const medals = ['🥇', '🥈', '🥉'];

  const lines = [];
  for (const entry of top) {
    const medal = entry.rank <= 3 ? medals[entry.rank - 1] : `${entry.rank}.`;
    const isMe = entry.telegramId === String(myTelegramId);
    const name = isMe ? `<b>${esc(entry.fio)}</b>` : esc(entry.fio);
    const suffix = showWorkplace && entry.workplace ? ` (${esc(WORKPLACE_SHORT[entry.workplace] || entry.workplace)})` : '';
    lines.push(`${medal} ${name}${suffix} — <b>${entry.value}</b>`);
  }

  if (me && me.rank > 10) {
    const meSuffix = showWorkplace && me.workplace ? ` (${esc(WORKPLACE_SHORT[me.workplace] || me.workplace)})` : '';
    lines.push('');
    lines.push(`⋮`);
    lines.push(`${me.rank}. <b>${esc(me.fio)}</b>${meSuffix} — <b>${me.value}</b>`);
  }

  return lines.join('\n');
}

function esc(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function checkNotifications(telegramId, fio, workplace, ordersCount) {
  const cache = loadCache();
  const record = cache.records[telegramId];
  if (!record || !record.dailyOrders) return [];

  const notifications = [];
  const dayKey = getTodayKey();

  const dailyOrders = { ...record.dailyOrders };
  const previousMax = Object.entries(dailyOrders)
    .filter(([k]) => k !== dayKey)
    .reduce((max, [, v]) => Math.max(max, v), 0);

  if (ordersCount > previousMax && previousMax > 0) {
    notifications.push({
      type: 'personal_record',
      value: ordersCount,
      previous: previousMax
    });
  }

  return notifications;
}

module.exports = {
  recordOrders,
  calculateLeaderboard,
  formatLeaderboard,
  checkNotifications,
  getTodayKey,
  flushNow,
  WORKPLACE_SHORT
};