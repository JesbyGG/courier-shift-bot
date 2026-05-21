const db = require('../db');

const ACHIEVEMENTS = [
  // Milestone: заказы
  { id: 'orders_50', name: '🛒 Новичок', desc: '50 заказов', condition: { type: 'orders', value: 50 }, reward: 100 },
  { id: 'orders_300', name: '🛒 Опытный', desc: '300 заказов', condition: { type: 'orders', value: 300 }, reward: 300 },
  { id: 'orders_1000', name: '🛒 Мастер', desc: '1 000 заказов', condition: { type: 'orders', value: 1000 }, reward: 800 },
  { id: 'orders_5000', name: '🛒 Гуру', desc: '5 000 заказов', condition: { type: 'orders', value: 5000 }, reward: 2000 },

  // Milestone: выручка
  { id: 'cash_10k', name: '💰 Первые деньги', desc: '10 000 ₽ выручки', condition: { type: 'cash', value: 10000 }, reward: 100 },
  { id: 'cash_500k', name: '💰 Финансист', desc: '500 000 ₽ выручки', condition: { type: 'cash', value: 500000 }, reward: 500 },
  { id: 'cash_1m', name: '💰 Миллионер', desc: '1 000 000 ₽ выручки', condition: { type: 'cash', value: 1000000 }, reward: 2000 },

  // Milestone: смены
  { id: 'shifts_30', name: '⏱ Трудоголик', desc: '30 смен', condition: { type: 'shifts', value: 30 }, reward: 200 },
  { id: 'shifts_200', name: '⏱ Вахта', desc: '200 смен', condition: { type: 'shifts', value: 200 }, reward: 1000 },
  { id: 'shifts_500', name: '⏱ Ветеран', desc: '500 смен', condition: { type: 'shifts', value: 500 }, reward: 3000 },

  // Streak
  { id: 'streak_3', name: '🔥 Воин', desc: '3 смены подряд', condition: { type: 'streak', value: 3 }, reward: 150 },
  { id: 'streak_7', name: '🔥 Железный', desc: '7 смен подряд', condition: { type: 'streak', value: 7 }, reward: 500 },
  { id: 'streak_14', name: '🔥 Несгибаемый', desc: '14 смен подряд', condition: { type: 'streak', value: 14 }, reward: 1500 },
  { id: 'streak_30', name: '🔥 Бог стрика', desc: '30 смен подряд', condition: { type: 'streak', value: 30 }, reward: 5000 },

  // Performance
  { id: 'top1_day', name: '🥇 День в шляпе', desc: 'Топ-1 дня', condition: { type: 'top1_day' }, reward: 500 },
  { id: 'rank_jump', name: '📈 Рывок', desc: 'Подняться на 3+ ранга за неделю', condition: { type: 'rank_jump' }, reward: 1000 },
  { id: 'orders_25', name: '⚡ Рекордсмен', desc: '25+ заказов за смену', condition: { type: 'orders_single', value: 25 }, reward: 500 },

  // Special
  { id: 'early_bird', name: '🐦 Ранняя пташка', desc: 'Начало смены до 07:00', condition: { type: 'early_bird' }, reward: 200 },
  { id: 'night_owl', name: '🦉 Ночная сова', desc: 'Конец смены после 00:00', condition: { type: 'night_owl' }, reward: 200 },
  { id: 'photographer', name: '📸 Фотограф', desc: '50 фото пробега без ошибки', condition: { type: 'photos', value: 50, courierType: 'auto' }, reward: 300 },
  { id: 'marathon', name: '🚶 Марафонец', desc: '10 000 шагов за день', condition: { type: 'steps', value: 10000, courierType: 'pedestrian' }, reward: 300 },
  { id: 'perfect_shift', name: '💎 Идеальная смена', desc: 'Маршрутник + сверка + наличные за день', condition: { type: 'perfect_shift' }, reward: 400 },
  { id: 'perfectionist', name: '🏆 Перфекционист', desc: '10 идеальных смен подряд', condition: { type: 'perfect_streak', value: 10 }, reward: 600 },
  { id: 'month_no_skip', name: '📅 Месяц без пропусков', desc: '30 рабочих дней', condition: { type: 'month_no_skip' }, reward: 1500 },
  { id: 'early_start_50', name: '🔄 Ранний старт', desc: '50 смен начаты до 09:00', condition: { type: 'early_start', value: 50 }, reward: 500 },
  { id: 'late_finish_50', name: '🌙 Поздний финиш', desc: '50 смен закончены после 22:00', condition: { type: 'late_finish', value: 50 }, reward: 500 },
  { id: 'reliable', name: '🤝 Надёжный', desc: '100 смен без жалоб', condition: { type: 'no_issues', value: 100 }, reward: 700 }
];

function getAllAchievements() {
  return ACHIEVEMENTS;
}

function getUnlockedAchievements(telegramId) {
  const rows = db.prepare('SELECT achievementId, unlockedAt FROM user_achievements WHERE telegramId = ?').all(String(telegramId));
  return rows.map(r => ({
    ...ACHIEVEMENTS.find(a => a.id === r.achievementId),
    unlockedAt: r.unlockedAt
  })).filter(Boolean);
}

function isAchievementUnlocked(telegramId, achievementId) {
  const row = db.prepare('SELECT 1 FROM user_achievements WHERE telegramId = ? AND achievementId = ?').get(String(telegramId), achievementId);
  return !!row;
}

function unlockAchievement(telegramId, achievementId) {
  if (isAchievementUnlocked(telegramId, achievementId)) return null;
  const ach = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!ach) return null;
  const stmt = db.prepare('INSERT INTO user_achievements (telegramId, achievementId, unlockedAt) VALUES (?, ?, ?)');
  stmt.run(String(telegramId), achievementId, new Date().toISOString());
  return ach;
}

function checkMilestoneAchievements(telegramId, stats) {
  const unlocked = [];
  for (const ach of ACHIEVEMENTS) {
    if (isAchievementUnlocked(telegramId, ach.id)) continue;
    if (ach.condition.type === 'orders' && (stats.totalOrders || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
    if (ach.condition.type === 'cash' && (stats.totalCash || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
    if (ach.condition.type === 'shifts' && (stats.totalShifts || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
    if (ach.condition.type === 'photos' && (stats.totalPhotos || 0) >= ach.condition.value) {
      if (!ach.condition.courierType || stats.courierType === ach.condition.courierType) {
        unlockAchievement(telegramId, ach.id);
        unlocked.push(ach);
      }
    }
    if (ach.condition.type === 'steps' && (stats.totalSteps || 0) >= ach.condition.value) {
      if (!ach.condition.courierType || stats.courierType === ach.condition.courierType) {
        unlockAchievement(telegramId, ach.id);
        unlocked.push(ach);
      }
    }
    if (ach.condition.type === 'streak' && (stats.currentStreak || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
    if (ach.condition.type === 'early_start' && (stats.earlyStarts || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
    if (ach.condition.type === 'late_finish' && (stats.lateFinishes || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
    if (ach.condition.type === 'no_issues' && (stats.shiftsWithoutIssues || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
    if (ach.condition.type === 'perfect_streak' && (stats.perfectStreak || 0) >= ach.condition.value) {
      unlockAchievement(telegramId, ach.id);
      unlocked.push(ach);
    }
  }
  return unlocked;
}

module.exports = {
  getAllAchievements,
  getUnlockedAchievements,
  isAchievementUnlocked,
  unlockAchievement,
  checkMilestoneAchievements
};
