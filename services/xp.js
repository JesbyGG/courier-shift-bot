const db = require('../db');

const AUTO_RANKS = [
  { level: 1, name: '🆕 Новичок', threshold: 0 },
  { level: 2, name: '🛞 Стажёр', threshold: 1000 },
  { level: 3, name: '🚐 Развозчик', threshold: 3000 },
  { level: 4, name: '🚗 Курьер', threshold: 7000 },
  { level: 5, name: '🏎️ Бывалый', threshold: 15000 },
  { level: 6, name: '🛣️ Знаток трасс', threshold: 30000 },
  { level: 7, name: '⚡ Молния', threshold: 50000 },
  { level: 8, name: '🥈 Мастер доставки', threshold: 70000 },
  { level: 9, name: '🥇 Легенда дорог', threshold: 85000 },
  { level: 10, name: '👑 Король рейтинга', threshold: 100000 }
];

const PEDESTRIAN_RANKS = [
  { level: 1, name: '🆕 Новичок', threshold: 0 },
  { level: 2, name: '🚶‍♂️ Стажёр', threshold: 500 },
  { level: 3, name: '🏃 Бегун', threshold: 1500 },
  { level: 4, name: '🏃‍♂️ Курьер', threshold: 3500 },
  { level: 5, name: '🏃‍♀️ Бывалый', threshold: 7500 },
  { level: 6, name: '🦌 Знаток маршрутов', threshold: 15000 },
  { level: 7, name: '⚡ Ветер', threshold: 25000 },
  { level: 8, name: '🥈 Мастер доставки', threshold: 35000 },
  { level: 9, name: '🥇 Легенда шагомера', threshold: 42500 },
  { level: 10, name: '👑 Король рейтинга', threshold: 50000 }
];

const XP_ACTIONS = {
  punchStart: 15,
  punchEnd: 15,
  routeSheet: 30,
  reconciliation: 50,
  cashSubmit: 80,
  mileage: 30,
  top10: 150,
  top3: 300,
  top1: 800
};

function getRanks(courierType) {
  return courierType === 'pedestrian' ? PEDESTRIAN_RANKS : AUTO_RANKS;
}

function addXp(telegramId, amount, reason) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const stmt = db.prepare(
    'INSERT INTO xp_log (telegramId, amount, reason, createdAt) VALUES (?, ?, ?, ?)'
  );
  stmt.run(String(telegramId), amount, reason || '', new Date().toISOString());
}

function getTotalXp(telegramId) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) as total FROM xp_log WHERE telegramId = ?'
  ).get(String(telegramId));
  return Number(row?.total || 0);
}

function getRank(xp, courierType) {
  const ranks = getRanks(courierType);
  let current = ranks[0];
  for (const rank of ranks) {
    if (xp >= rank.threshold) {
      current = rank;
    } else {
      break;
    }
  }
  return current;
}

function getNextRank(xp, courierType) {
  const ranks = getRanks(courierType);
  for (const rank of ranks) {
    if (xp < rank.threshold) {
      return rank;
    }
  }
  return null;
}

function getRankProgress(xp, courierType) {
  const current = getRank(xp, courierType);
  const next = getNextRank(xp, courierType);
  if (!next) {
    return { percent: 100, current, next: null, remaining: 0 };
  }
  const prevThreshold = current.threshold;
  const range = next.threshold - prevThreshold;
  const progress = xp - prevThreshold;
  const percent = Math.min(100, Math.floor((progress / range) * 100));
  return {
    percent,
    current,
    next,
    remaining: next.threshold - xp
  };
}

function formatRankInfo(telegramId, courierType) {
  const xp = getTotalXp(telegramId);
  const prog = getRankProgress(xp, courierType);
  if (!prog.next) {
    return `${prog.current.name} — ${xp.toLocaleString('ru-RU')} XP (максимальный ранг!)`;
  }
  return `${prog.current.name} — ${xp.toLocaleString('ru-RU')} / ${prog.next.threshold.toLocaleString('ru-RU')} XP (${prog.percent}%)`;
}

function getXpForAction(actionKey) {
  return XP_ACTIONS[actionKey] || 0;
}

module.exports = {
  addXp,
  getTotalXp,
  getRank,
  getNextRank,
  getRankProgress,
  formatRankInfo,
  getXpForAction,
  AUTO_RANKS,
  PEDESTRIAN_RANKS
};
