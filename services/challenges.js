const db = require('../db');

const CHALLENGE_POOL = {
  common: [
    { id: 'doc_5', name: '📸 Документалист', desc: 'Отправить 5 маршрутников за неделю', target: 5, reward: 100, metric: 'routeSheets' },
    { id: 'rec_3', name: '📊 Сверщик', desc: 'Отправить 3 сверки за неделю', target: 3, reward: 150, metric: 'reconciliations' },
    { id: 'cash_3', name: '💵 Копилка', desc: 'Сдать наличные 3 раза за неделю', target: 3, reward: 150, metric: 'cashSubmits' },
    { id: 'shifts_5', name: '⏱ Трудяга', desc: '5 смен за неделю', target: 5, reward: 300, metric: 'shifts' }
  ],
  auto: [
    { id: 'mile_5', name: '🚗 Одометр', desc: 'Записать пробег 5 раз за неделю', target: 5, reward: 100, metric: 'mileages' },
    { id: 'eco', name: '🚗 Эконом', desc: 'Средний пробег ≤ 15 км/заказ (мин. 30 заказов)', target: 30, reward: 500, metric: 'ecoMileage' }
  ],
  pedestrian: [
    { id: 'sprint', name: '🚶 Спиринт', desc: '30+ заказов за 1 смену', target: 1, reward: 500, metric: 'sprintDay' },
    { id: 'light_feet', name: '🚶 Лёгкие ноги', desc: '20+ заказов за смену 3 раза за неделю', target: 3, reward: 300, metric: 'highOrderDays' }
  ]
};

function getWeekId(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + 1); // понедельник
  return d.toISOString().split('T')[0];
}

function generateWeeklyChallenges(telegramId, courierType) {
  const weekId = getWeekId();
  const existing = db.prepare('SELECT 1 FROM challenges WHERE weekId = ? AND telegramId = ?').get(weekId, String(telegramId));
  if (existing) return getChallenges(telegramId);

  const pool = [...CHALLENGE_POOL.common];
  if (courierType === 'auto') {
    pool.push(...CHALLENGE_POOL.auto);
  } else {
    pool.push(...CHALLENGE_POOL.pedestrian);
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

function findChallengeTemplate(type) {
  const all = [...CHALLENGE_POOL.common, ...CHALLENGE_POOL.auto, ...CHALLENGE_POOL.pedestrian];
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

module.exports = {
  generateWeeklyChallenges,
  getChallenges,
  updateChallengeProgress,
  getWeekId
};
