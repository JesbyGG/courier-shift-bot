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

  // Performance
  { id: 'top1_day', name: '🥇 День в шляпе', desc: 'Топ-1 дня', condition: { type: 'top1_day' }, reward: 500 },
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

function getAchievementStats(telegramId) {
  const allTimeOrders = db.prepare('SELECT COALESCE(SUM(orders), 0) as total FROM daily_orders WHERE telegramId = ?').get(String(telegramId));
  const streakRow = db.prepare('SELECT currentStreak, maxStreak FROM streaks WHERE telegramId = ?').get(String(telegramId));
  const userRow = db.prepare('SELECT data FROM users WHERE telegramId = ?').get(String(telegramId));
  let totalShifts = 0;
  let totalCash = 0;
  let earlyStarts = 0;
  let lateFinishes = 0;
  let courierType = 'auto';
  let totalPhotos = 0;
  let daysWorked = 0;
  let shiftsWithoutIssues = 0;
  let perfectStreak = 0;
  let earlyBird = false;
  let nightOwl = false;
  let perfectShift = false;
  let top1Day = false;
  let rankJump = false;
  let totalSteps = 0;

  if (userRow) {
    try {
      const ud = JSON.parse(userRow.data);
      totalShifts = ud.shiftCount || 0;
      totalCash = ud.totalCashRecorded || 0;
      earlyStarts = ud.earlyStarts || 0;
      lateFinishes = ud.lateFinishes || 0;
      courierType = ud.courierType || 'auto';
      totalPhotos = ud.totalPhotos || 0;
      daysWorked = ud.daysWorked || 0;
      shiftsWithoutIssues = ud.shiftsWithoutIssues || 0;
      perfectStreak = ud.perfectStreak || 0;
      earlyBird = ud.earlyBird || false;
      nightOwl = ud.nightOwl || false;
      perfectShift = ud.perfectShift || false;
      top1Day = ud.top1Day || false;
      rankJump = ud.rankJump || false;
      totalSteps = ud.totalSteps || 0;
    } catch (_) {}
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayRow = db.prepare('SELECT orders FROM daily_orders WHERE telegramId = ? AND date = ?').get(String(telegramId), todayKey);
  const singleDayOrders = todayRow ? Number(todayRow.orders) || 0 : 0;

  return {
    totalOrders: allTimeOrders ? Number(allTimeOrders.total) || 0 : 0,
    totalCash,
    totalShifts,
    currentStreak: streakRow ? Number(streakRow.currentStreak) || 0 : 0,
    maxStreak: streakRow ? Number(streakRow.maxStreak) || 0 : 0,
    courierType,
    earlyStarts,
    lateFinishes,
    singleDayOrders,
    totalPhotos,
    daysWorked,
    shiftsWithoutIssues,
    perfectStreak,
    earlyBird,
    nightOwl,
    perfectShift,
    top1Day,
    rankJump,
    totalSteps
  };
}

function formatProgressBar(current, target) {
  if (!Number.isFinite(target) || target <= 0) return '';
  const pct = Math.min(1, Math.max(0, current / target));
  const filled = Math.round(pct * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function getConditionProgress(stats, condition) {
  const type = condition.type;
  const value = condition.value || 0;
  let current = 0;
  let isBoolean = false;

  switch (type) {
    case 'orders': current = stats.totalOrders; break;
    case 'cash': current = stats.totalCash; break;
    case 'shifts': current = stats.totalShifts; break;
    case 'photos': current = stats.totalPhotos; break;
    case 'steps': current = stats.totalSteps; break;
    case 'streak': current = stats.currentStreak; break;
    case 'early_start': current = stats.earlyStarts; break;
    case 'late_finish': current = stats.lateFinishes; break;
    case 'no_issues': current = stats.shiftsWithoutIssues; break;
    case 'perfect_streak': current = stats.perfectStreak; break;
    case 'orders_single': current = stats.singleDayOrders; break;
    case 'month_no_skip': current = stats.daysWorked; break;
    case 'top1_day': current = stats.top1Day ? 1 : 0; isBoolean = true; break;
    case 'early_bird': current = stats.earlyBird ? 1 : 0; isBoolean = true; break;
    case 'night_owl': current = stats.nightOwl ? 1 : 0; isBoolean = true; break;
    case 'perfect_shift': current = stats.perfectShift ? 1 : 0; isBoolean = true; break;
    case 'rank_jump': current = stats.rankJump ? 1 : 0; isBoolean = true; break;
    default: current = 0;
  }

  return { current, target: value, isBoolean };
}

function formatAchievementsWithProgress(telegramId) {
  const stats = getAchievementStats(telegramId);
  const unlocked = getUnlockedAchievements(telegramId);
  const unlockedIds = new Set(unlocked.map(a => a.id));

  const categories = {
    orders: { emoji: '🛒', label: 'Заказы', achievements: [] },
    cash: { emoji: '💰', label: 'Выручка', achievements: [] },
    shifts: { emoji: '⏱', label: 'Смены', achievements: [] },
    special: { emoji: '🏆', label: 'Особые', achievements: [] }
  };

  for (const ach of ACHIEVEMENTS) {
    const isDone = unlockedIds.has(ach.id);
    const isBlocked = ach.condition.courierType && ach.condition.courierType !== stats.courierType;
    const progress = getConditionProgress(stats, ach.condition);

    let statusIcon = '⏳';
    if (isDone) statusIcon = '✅';
    else if (isBlocked) statusIcon = '🔒';
    else if (ach.condition.type === 'top1_day' || ach.condition.type === 'early_bird' || ach.condition.type === 'night_owl' || ach.condition.type === 'perfect_shift' || ach.condition.type === 'rank_jump') {
      statusIcon = '⏳';
    }

    let progressLine = '';
    if (!isDone && !isBlocked && !progress.isBoolean && progress.target > 0) {
      const bar = formatProgressBar(progress.current, progress.target);
      progressLine = `\n   ${bar} ${progress.current.toLocaleString('ru-RU')}/${progress.target.toLocaleString('ru-RU')}`;
    }

    const line = `${statusIcon} <b>${ach.name}</b> — ${ach.desc}${ach.reward > 0 ? ` (+${ach.reward} XP)` : ''}${progressLine}`;

    // Определяем категорию
    const type = ach.condition.type;
    if (type === 'orders' || type === 'orders_single') categories.orders.achievements.push(line);
    else if (type === 'cash') categories.cash.achievements.push(line);
    else if (type === 'shifts' || type === 'streak' || type === 'early_start' || type === 'late_finish' || type === 'no_issues' || type === 'perfect_streak' || type === 'month_no_skip') categories.shifts.achievements.push(line);
    else categories.special.achievements.push(line);
  }

  let text = '🏆 <b>Все достижения</b>\n';
  text += `<i>Разблокировано: ${unlocked.length} / ${ACHIEVEMENTS.length}</i>\n\n`;

  for (const key of ['orders', 'cash', 'shifts', 'special']) {
    const cat = categories[key];
    if (cat.achievements.length === 0) continue;
    text += `${cat.emoji} <b>${cat.label}</b>\n`;
    text += cat.achievements.join('\n') + '\n\n';
  }

  text += '<i>✅ — выполнено, ⏳ — в процессе, 🔒 — не для вашего типа курьера</i>';
  return text;
}

function checkMilestoneAchievements(telegramId, stats) {
  const db = require('../db');
  const unlocked = [];
  for (const ach of ACHIEVEMENTS) {
    if (isAchievementUnlocked(telegramId, ach.id)) continue;
    let met = false;

    if (ach.condition.type === 'orders' && (stats.totalOrders || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'cash' && (stats.totalCash || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'shifts' && (stats.totalShifts || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'photos' && (stats.totalPhotos || 0) >= ach.condition.value) {
      met = !ach.condition.courierType || stats.courierType === ach.condition.courierType;
    } else if (ach.condition.type === 'steps' && (stats.totalSteps || 0) >= ach.condition.value) {
      met = !ach.condition.courierType || stats.courierType === ach.condition.courierType;
    } else if (ach.condition.type === 'streak' && (stats.currentStreak || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'early_start' && (stats.earlyStarts || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'late_finish' && (stats.lateFinishes || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'no_issues' && (stats.shiftsWithoutIssues || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'perfect_streak' && (stats.perfectStreak || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'orders_single' && (stats.singleDayOrders || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'top1_day' && stats.top1Day) met = true;
    else if (ach.condition.type === 'early_bird' && stats.earlyBird) met = true;
    else if (ach.condition.type === 'night_owl' && stats.nightOwl) met = true;
    else if (ach.condition.type === 'perfect_shift' && stats.perfectShift) met = true;
    else if (ach.condition.type === 'month_no_skip' && (stats.daysWorked || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'rank_jump' && stats.rankJump) met = true;

    if (met) {
      const result = unlockAchievement(telegramId, ach.id);
      if (result) {
        // Начисляем XP за достижение
        if (ach.reward > 0) {
          try {
            const { addXp } = require('./xp');
            addXp(telegramId, ach.reward, `Достижение: ${ach.name}`);
          } catch (_) {}
        }
        unlocked.push(ach);
      }
    }
  }
  return unlocked;
}

async function notifyAchievements(ctx, telegramId, unlocked) {
  if (!unlocked || unlocked.length === 0) return;
  const sendMsg = async (id, msg) => {
    try {
      await ctx.telegram.sendMessage(id, msg, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('notifyAchievements send error', e.message);
    }
  };
  for (const ach of unlocked) {
    const msg = `🏆 <b>Достижение разблокировано!</b>\n\n${ach.name}\n<i>${ach.desc}</i>${ach.reward > 0 ? `\n\n+${ach.reward} XP` : ''}`;
    await sendMsg(telegramId, msg);
  }
}

module.exports = {
  getAllAchievements,
  getUnlockedAchievements,
  isAchievementUnlocked,
  unlockAchievement,
  checkMilestoneAchievements,
  getAchievementStats,
  notifyAchievements,
  formatAchievementsWithProgress,
  formatProgressBar
};
