const db = require('../db');

function getStreak(telegramId) {
  const row = db.prepare('SELECT currentStreak, maxStreak, lastShiftDate FROM streaks WHERE telegramId = ?').get(String(telegramId));
  if (!row) {
    return { currentStreak: 0, maxStreak: 0, lastShiftDate: null };
  }
  return {
    currentStreak: Number(row.currentStreak || 0),
    maxStreak: Number(row.maxStreak || 0),
    lastShiftDate: row.lastShiftDate || null
  };
}

function updateStreak(telegramId, shiftDateStr) {
  const record = getStreak(telegramId);
  let current = record.currentStreak;
  let max = record.maxStreak;

  if (record.lastShiftDate) {
    const last = new Date(record.lastShiftDate);
    const today = new Date(shiftDateStr);
    const diffMs = today - last;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      // та же дата — не увеличиваем стрик
    } else if (diffDays <= 2) {
      current += 1;
    } else {
      current = 1;
    }
  } else {
    current = 1;
  }

  if (current > max) {
    max = current;
  }

  const stmt = db.prepare(
    'INSERT OR REPLACE INTO streaks (telegramId, currentStreak, maxStreak, lastShiftDate) VALUES (?, ?, ?, ?)'
  );
  stmt.run(String(telegramId), current, max, shiftDateStr);

  return { currentStreak: current, maxStreak: max, lastShiftDate: shiftDateStr };
}

function getStreakBonus(currentStreak) {
  if (currentStreak > 0 && currentStreak % 5 === 0) {
    return 50;
  }
  return 0;
}

module.exports = {
  getStreak,
  updateStreak,
  getStreakBonus
};
