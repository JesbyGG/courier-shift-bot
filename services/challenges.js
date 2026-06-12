const db = require('../db');
const { pe } = require('./premiumEmoji');

const CHALLENGE_POOL = {
  common: [
    { id: 'doc_5', name: '📸 Документалист', desc: 'Отправить 5 маршрутников за неделю', target: 5, reward: 100, metric: 'routeSheets' },
    { id: 'rec_3', name: '📊 Сверщик', desc: 'Отправить 3 сверки за неделю', target: 3, reward: 150, metric: 'reconciliations' },
    { id: 'cash_3', name: '💵 Копилка', desc: 'Сдать наличные 3 раза за неделю', target: 3, reward: 150, metric: 'cashSubmits' },
    { id: 'shifts_5', name: '⏱ Трудяга', desc: '5 смен за неделю', target: 5, reward: 300, metric: 'shifts' }
  ],
  auto: [
    { id: 'mile_5', name: '🚗 Одометр', desc: 'Записать пробег 5 раз за неделю', target: 5, reward: 100, metric: 'mileages' }
  ],
  pedestrian: [
    // Пешие курьеры получают только common челленджи (у них нет пробега)
  ]
};

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

function getWeekId(date = new Date()) {
  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const d = new Date(date);
  // Переводим в локальную дату (без времени), чтобы понедельник всегда был понедельником
  const localDateStr = _formatLocalDate(d, timezone);
  const localDate = new Date(localDateStr + 'T00:00:00');
  const dayOfWeek = localDate.getDay(); // 0 = Воскресенье, 1 = Понедельник
  // Вычисляем понедельник текущей недели
  const diff = localDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  localDate.setDate(diff);
  return localDate.toISOString().split('T')[0];
}

function generateWeeklyChallenges(telegramId, courierType) {
  const weekId = getWeekId();
  const existing = db.prepare('SELECT 1 FROM challenges WHERE weekId = ? AND telegramId = ?').get(weekId, String(telegramId));
  if (existing) return getChallenges(telegramId);

  const pool = [...CHALLENGE_POOL.common];
  if (courierType === 'auto') {
    pool.push(...CHALLENGE_POOL.auto);
  }

  const shuffled = pool.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 3);

  const stmt = db.prepare(
    'INSERT INTO challenges (weekId, telegramId, type, target, current, completed, reward) VALUES (?, ?, ?, ?, 0, 0, ?)'
  );
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      stmt.run(weekId, String(telegramId), item.id, item.target, item.reward);
    }
  });
  insertMany(selected);

  return selected.map(s => ({ ...s, current: 0, completed: 0 }));
}

function getChallenges(telegramId) {
  const weekId = getWeekId();
  const rows = db.prepare('SELECT * FROM challenges WHERE weekId = ? AND telegramId = ?').all(weekId, String(telegramId));
  return rows.map(r => {
    const template = findChallengeTemplate(r.type);
    return {
      ...template,
      target: r.target,
      current: r.current,
      completed: r.completed,
      reward: r.reward
    };
  });
}

function formatProgressBar(current, target) {
  if (!Number.isFinite(target) || target <= 0) return '';
  const pct = Math.min(1, Math.max(0, current / target));
  const filled = Math.round(pct * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function findChallengeTemplate(type) {
  const all = [...CHALLENGE_POOL.common, ...CHALLENGE_POOL.auto];
  return all.find(c => c.id === type) || { id: type, name: type, desc: '', metric: type };
}

function updateChallengeProgress(telegramId, metric, value = 1) {
  const weekId = getWeekId();
  const rows = db.prepare('SELECT * FROM challenges WHERE weekId = ? AND telegramId = ? AND completed = 0').all(weekId, String(telegramId));
  const completed = [];
  for (const row of rows) {
    const template = findChallengeTemplate(row.type);
    if (template.metric !== metric) continue;
    const newCurrent = (row.current || 0) + value;
    if (newCurrent >= row.target) {
      db.prepare('UPDATE challenges SET current = ?, completed = 1 WHERE weekId = ? AND telegramId = ? AND type = ?')
        .run(newCurrent, weekId, String(telegramId), row.type);
      completed.push({ ...template, reward: row.reward });
    } else {
      db.prepare('UPDATE challenges SET current = ? WHERE weekId = ? AND telegramId = ? AND type = ?')
        .run(newCurrent, weekId, String(telegramId), row.type);
    }
  }
  return completed;
}

function cleanupOldChallenges(retentionWeeks = 4) {
  try {
    const currentWeekId = getWeekId();
    const currentDate = new Date(currentWeekId + 'T00:00:00');
    const cutoffDate = new Date(currentDate);
    cutoffDate.setDate(cutoffDate.getDate() - retentionWeeks * 7);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    const result = db.prepare('DELETE FROM challenges WHERE weekId < ?').run(cutoff);
    if (result.changes > 0) {
      console.log(`cleaned up ${result.changes} old challenge record(s) older than ${cutoff}`);
    }
  } catch (e) {
    console.error('cleanupOldChallenges error', e.message);
  }
}

function cleanupInvalidChallenges() {
  try {
    const validIds = new Set([...CHALLENGE_POOL.common, ...CHALLENGE_POOL.auto].map(c => c.id));
    const rows = db.prepare('SELECT DISTINCT type FROM challenges').all();
    let removed = 0;
    for (const row of rows) {
      if (!validIds.has(row.type)) {
        const result = db.prepare('DELETE FROM challenges WHERE type = ?').run(row.type);
        removed += result.changes;
      }
    }
    if (removed > 0) {
      console.log(`cleaned up ${removed} invalid challenge record(s)`);
    }
  } catch (e) {
    console.error('cleanupInvalidChallenges error', e.message);
  }
}

function notifyChallengeCompleted(ctx, telegramId, challenge) {
  if (!challenge) return;
  const sendMsg = async (id, msg) => {
    try {
      await ctx.telegram.sendMessage(id, msg, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('notifyChallengeCompleted send error', e.message);
    }
  };
  const msg = (
    `${pe('🔥')} <b>Челлендж выполнен!</b>\n\n` +
    `${challenge.name}\n` +
    `<i>${challenge.desc}</i>\n\n` +
    `Награда: <b>+${challenge.reward} XP</b>\n\n` +
    `${pe('💪')} Так держать! Ты настоящий профи! ${pe('🚀')}`
  );
  sendMsg(telegramId, msg);
}

module.exports = {
  generateWeeklyChallenges,
  getChallenges,
  updateChallengeProgress,
  getWeekId,
  cleanupOldChallenges,
  cleanupInvalidChallenges,
  findChallengeTemplate,
  notifyChallengeCompleted,
  formatProgressBar
};
