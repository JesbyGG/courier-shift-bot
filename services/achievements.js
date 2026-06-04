const db = require('../db');

const ACHIEVEMENTS = [
  // Заказы
  { id: 'orders_50', name: 'Новичок', desc: '50 заказов', condition: { type: 'orders', value: 50 }, reward: 100 },
  { id: 'orders_300', name: 'Опытный', desc: '300 заказов', condition: { type: 'orders', value: 300 }, reward: 300 },
  { id: 'orders_1000', name: 'Мастер', desc: '1 000 заказов', condition: { type: 'orders', value: 1000 }, reward: 800 },
  { id: 'orders_5000', name: 'Гуру', desc: '5 000 заказов', condition: { type: 'orders', value: 5000 }, reward: 2000 },
  { id: 'orders_25', name: 'Рекордсмен', desc: '25+ заказов за смену', condition: { type: 'orders_single', value: 25 }, reward: 500 },

  // Выручка
  { id: 'cash_10k', name: 'Первые деньги', desc: '10 000 ₽ выручки', condition: { type: 'cash', value: 10000 }, reward: 100 },
  { id: 'cash_500k', name: 'Финансист', desc: '500 000 ₽ выручки', condition: { type: 'cash', value: 500000 }, reward: 500 },
  { id: 'cash_1m', name: 'Миллионер', desc: '1 000 000 ₽ выручки', condition: { type: 'cash', value: 1000000 }, reward: 2000 },

  // Смены
  { id: 'first_shift', name: 'Первый шаг', desc: 'Первая смена', condition: { type: 'shifts', value: 1 }, reward: 50 },
  { id: 'shifts_30', name: 'Трудоголик', desc: '30 смен', condition: { type: 'shifts', value: 30 }, reward: 200 },
  { id: 'shifts_200', name: 'Вахта', desc: '200 смен', condition: { type: 'shifts', value: 200 }, reward: 1000 },
  { id: 'shifts_500', name: 'Ветеран', desc: '500 смен', condition: { type: 'shifts', value: 500 }, reward: 3000 },
  { id: 'early_start_50', name: 'Ранний старт', desc: '50 смен начаты до 09:00', condition: { type: 'early_start', value: 50 }, reward: 500 },
  { id: 'late_finish_50', name: 'Поздний финиш', desc: '50 смен закончены после 22:00', condition: { type: 'late_finish', value: 50 }, reward: 500 },

  // Маршрутники
  { id: 'first_route', name: 'Первый маршрутник', desc: 'Отправить первый маршрутник', condition: { type: 'route_sheets', value: 1 }, reward: 50 },
  { id: 'route_50', name: 'Бумажный волк', desc: '50 маршрутников', condition: { type: 'route_sheets', value: 50 }, reward: 200 },
  { id: 'route_100', name: 'Бумажный тигр', desc: '100 маршрутников', condition: { type: 'route_sheets', value: 100 }, reward: 400 },
  { id: 'route_200', name: 'Бумажный лев', desc: '200 маршрутников', condition: { type: 'route_sheets', value: 200 }, reward: 800 },

  // Сверки
  { id: 'first_rec', name: 'Первый сверщик', desc: 'Первая сверка', condition: { type: 'reconciliations', value: 1 }, reward: 50 },
  { id: 'rec_30', name: 'Сверщик-эксперт', desc: '30 сверок', condition: { type: 'reconciliations', value: 30 }, reward: 200 },
  { id: 'rec_50', name: 'Сверщик-мастер', desc: '50 сверок', condition: { type: 'reconciliations', value: 50 }, reward: 400 },
  { id: 'rec_100', name: 'Сверщик-легенда', desc: '100 сверок', condition: { type: 'reconciliations', value: 100 }, reward: 800 },

  // Наличные
  { id: 'first_cash', name: 'Первые деньги', desc: 'Первая сдача наличных', condition: { type: 'cash_submits', value: 1 }, reward: 50 },
  { id: 'cash_submit_50', name: 'Кассир', desc: '50 сдач наличных', condition: { type: 'cash_submits', value: 50 }, reward: 200 },
  { id: 'cash_submit_100', name: 'Главный кассир', desc: '100 сдач наличных', condition: { type: 'cash_submits', value: 100 }, reward: 500 },

  // Пробег (только авто)
  { id: 'first_mileage', name: 'Первый пробег', desc: 'Первая запись пробега', condition: { type: 'mileage_records', value: 1, courierType: 'auto' }, reward: 50 },
  { id: 'mileage_50', name: 'Заправка', desc: '50 записей пробега', condition: { type: 'mileage_records', value: 50, courierType: 'auto' }, reward: 200 },
  { id: 'mileage_100', name: 'Полный бак', desc: '100 записей пробега', condition: { type: 'mileage_records', value: 100, courierType: 'auto' }, reward: 400 },
  { id: 'mileage_200', name: 'Заправщик', desc: '200 записей пробега', condition: { type: 'mileage_records', value: 200, courierType: 'auto' }, reward: 800 },

  // Экспресс-заказы
  { id: 'express_30', name: 'Экспресс', desc: '30+ заказов за смену', condition: { type: 'orders_single', value: 30 }, reward: 300 },
  { id: 'express_35', name: 'Супер-экспресс', desc: '35+ заказов за смену', condition: { type: 'orders_single', value: 35 }, reward: 500 },
  { id: 'express_40', name: 'Молния', desc: '40+ заказов за смену', condition: { type: 'orders_single', value: 40 }, reward: 1000 },

  // Топ-1
  { id: 'top1_5', name: 'Король дня', desc: '5 раз топ-1', condition: { type: 'top1_count', value: 5 }, reward: 300 },
  { id: 'top1_10', name: 'Император', desc: '10 раз топ-1', condition: { type: 'top1_count', value: 10 }, reward: 600 },
  { id: 'top1_20', name: 'Бог рейтинга', desc: '20 раз топ-1', condition: { type: 'top1_count', value: 20 }, reward: 1500 },

  // Стрик
  { id: 'streak_7', name: 'Стойкость', desc: '7 смен подряд', condition: { type: 'streak', value: 7 }, reward: 200 },
  { id: 'streak_14', name: 'Железная воля', desc: '14 смен подряд', condition: { type: 'streak', value: 14 }, reward: 500 },
  { id: 'streak_30', name: 'Марафонец', desc: '30 смен подряд', condition: { type: 'streak', value: 30 }, reward: 1500 },

  // Особые
  { id: 'top1_day', name: 'День в шляпе', desc: 'Топ-1 дня', condition: { type: 'top1_day' }, reward: 500 },
  { id: 'early_bird', name: 'Ранняя пташка', desc: 'Начало смены до 07:00', condition: { type: 'early_bird' }, reward: 200 },
  { id: 'night_owl', name: 'Ночная сова', desc: 'Конец смены после 00:00', condition: { type: 'night_owl' }, reward: 200 },
  { id: 'perfect_shift', name: 'Идеальная смена', desc: 'Маршрутник + сверка + наличные за день', condition: { type: 'perfect_shift' }, reward: 400 }
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
  let earlyBird = false;
  let nightOwl = false;
  let perfectShift = false;
  let top1Day = false;
  let routeSheets = 0;
  let reconciliations = 0;
  let cashSubmits = 0;
  let mileageRecords = 0;
  let top1Count = 0;

  if (userRow) {
    try {
      const ud = JSON.parse(userRow.data);
      totalShifts = ud.shiftCount || 0;
      totalCash = ud.totalCashRecorded || 0;
      earlyStarts = ud.earlyStarts || 0;
      lateFinishes = ud.lateFinishes || 0;
      courierType = ud.courierType || 'auto';
      earlyBird = ud.earlyBird || false;
      nightOwl = ud.nightOwl || false;
      perfectShift = ud.perfectShift || false;
      top1Day = ud.top1Day || false;
      routeSheets = ud.routeSheetsSubmitted || 0;
      reconciliations = ud.reconciliationsSubmitted || 0;
      cashSubmits = ud.cashSubmits || 0;
      mileageRecords = ud.mileageRecords || 0;
      top1Count = ud.top1Count || 0;
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
    earlyBird,
    nightOwl,
    perfectShift,
    top1Day,
    routeSheets,
    reconciliations,
    cashSubmits,
    mileageRecords,
    top1Count
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
    case 'early_start': current = stats.earlyStarts; break;
    case 'late_finish': current = stats.lateFinishes; break;
    case 'orders_single': current = stats.singleDayOrders; break;
    case 'route_sheets': current = stats.routeSheets; break;
    case 'reconciliations': current = stats.reconciliations; break;
    case 'cash_submits': current = stats.cashSubmits; break;
    case 'mileage_records': current = stats.mileageRecords; break;
    case 'top1_count': current = stats.top1Count; break;
    case 'streak': current = stats.currentStreak; break;
    case 'top1_day': current = stats.top1Day ? 1 : 0; isBoolean = true; break;
    case 'early_bird': current = stats.earlyBird ? 1 : 0; isBoolean = true; break;
    case 'night_owl': current = stats.nightOwl ? 1 : 0; isBoolean = true; break;
    case 'perfect_shift': current = stats.perfectShift ? 1 : 0; isBoolean = true; break;
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
    docs: { emoji: '📄', label: 'Документы', achievements: [] },
    special: { emoji: '⭐', label: 'Особые', achievements: [] }
  };

  for (const ach of ACHIEVEMENTS) {
    // Пропускаем достижения не для этого типа курьера
    if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) continue;

    const isDone = unlockedIds.has(ach.id);
    const progress = getConditionProgress(stats, ach.condition);

    const statusIcon = isDone ? '✅' : '⏳';

    let progressLine = '';
    if (!isDone && !progress.isBoolean && progress.target > 0) {
      progressLine = ` — ${progress.current.toLocaleString('ru-RU')}/${progress.target.toLocaleString('ru-RU')}`;
    }

    const line = `${statusIcon} ${ach.name}${progressLine}`;

    // Определяем категорию
    const type = ach.condition.type;
    if (type === 'orders' || type === 'orders_single') categories.orders.achievements.push(line);
    else if (type === 'cash' || type === 'cash_submits') categories.cash.achievements.push(line);
    else if (type === 'shifts' || type === 'early_start' || type === 'late_finish' || type === 'streak') categories.shifts.achievements.push(line);
    else if (type === 'route_sheets' || type === 'reconciliations' || type === 'mileage_records') categories.docs.achievements.push(line);
    else categories.special.achievements.push(line);
  }

  let text = `🏆 Мои достижения (${unlocked.length}/${ACHIEVEMENTS.length})\n\n`;

  for (const key of ['orders', 'cash', 'shifts', 'docs', 'special']) {
    const cat = categories[key];
    if (cat.achievements.length === 0) continue;
    text += `${cat.emoji} ${cat.label}\n`;
    text += cat.achievements.join('\n') + '\n\n';
  }

  return text.trim();
}

function checkMilestoneAchievements(telegramId, stats) {
  const db = require('../db');
  const unlocked = [];
  for (const ach of ACHIEVEMENTS) {
    if (isAchievementUnlocked(telegramId, ach.id)) continue;

    // Пропускаем если не подходит тип курьера
    if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) continue;

    let met = false;

    if (ach.condition.type === 'orders' && (stats.totalOrders || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'cash' && (stats.totalCash || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'shifts' && (stats.totalShifts || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'early_start' && (stats.earlyStarts || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'late_finish' && (stats.lateFinishes || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'orders_single' && (stats.singleDayOrders || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'route_sheets' && (stats.routeSheets || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'reconciliations' && (stats.reconciliations || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'cash_submits' && (stats.cashSubmits || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'mileage_records' && (stats.mileageRecords || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'top1_count' && (stats.top1Count || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'streak' && (stats.currentStreak || 0) >= ach.condition.value) met = true;
    else if (ach.condition.type === 'top1_day' && stats.top1Day) met = true;
    else if (ach.condition.type === 'early_bird' && stats.earlyBird) met = true;
    else if (ach.condition.type === 'night_owl' && stats.nightOwl) met = true;
    else if (ach.condition.type === 'perfect_shift' && stats.perfectShift) met = true;

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
