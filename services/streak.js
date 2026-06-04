const db = require('../db');

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

function _daysBetween(dateA, dateB) {
  const a = new Date(dateA + 'T00:00:00');
  const b = new Date(dateB + 'T00:00:00');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

const STREAK_BONUSES = [
  { threshold: 10, xp: 50 },
  { threshold: 25, xp: 100 },
  { threshold: 50, xp: 200 },
  { threshold: 100, xp: 500 }
];

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
  const oldCurrent = current;
  const oldMax = max;

  if (record.lastShiftDate) {
    const diffDays = _daysBetween(record.lastShiftDate, shiftDateStr);

    if (diffDays === 0) {
      // Та же дата — стрик не меняем
    } else if (diffDays < 0) {
      // Дата в прошлом (маловероятно, но защита) — ничего не делаем
      console.warn('streak: shift date is in the past', { telegramId, lastDate: record.lastShiftDate, shiftDate: shiftDateStr });
    } else {
      // За каждый пропущенный день -1, потом +1 за текущий день
      const missedDays = diffDays - 1;
      current = Math.max(0, current - missedDays);
      current += 1;
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

  // Вычисляем бонусы XP за пороги
  const bonuses = [];
  for (const { threshold, xp } of STREAK_BONUSES) {
    if (current >= threshold && oldCurrent < threshold && oldMax < threshold) {
      bonuses.push({ threshold, xp });
    }
  }

  return {
    currentStreak: current,
    maxStreak: max,
    lastShiftDate: shiftDateStr,
    bonuses
  };
}

function getStreakBonusesDescription(bonuses) {
  if (!bonuses || bonuses.length === 0) return '';
  const lines = bonuses.map(b => `🔥 Стрик ${b.threshold}! +${b.xp} XP`);
  return '\n' + lines.join('\n');
}

function formatStreakInfo(telegramId) {
  const streak = getStreak(telegramId);
  if (streak.currentStreak === 0) {
    return '🔥 Стрик: нет активного (рекорд: ' + streak.maxStreak + ')';
  }
  let text = `🔥 Стрик: <b>${streak.currentStreak}</b> смен (рекорд: ${streak.maxStreak})`;
  // Показываем ближайший бонус
  for (const { threshold, xp } of STREAK_BONUSES) {
    if (streak.currentStreak < threshold) {
      const remaining = threshold - streak.currentStreak;
      text += `\n💪 Ещё ${remaining} смен до +${xp} XP`;
      break;
    }
  }
  return text;
}

module.exports = {
  getStreak,
  updateStreak,
  getStreakBonusesDescription,
  formatStreakInfo,
  STREAK_BONUSES
};
