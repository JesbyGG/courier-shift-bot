const db = require('../db');

const CATEGORY_MAP = {
  orders: { emoji: '🛒', label: 'Заказы' },
  cash: { emoji: '💰', label: 'Выручка' },
  shifts: { emoji: '⏱', label: 'Смены' },
  docs: { emoji: '📄', label: 'Документы' },
  special: { emoji: '⭐', label: 'Особые' }
};

const SUBCATEGORY_MAP = {
  orders_quantity: { emoji: '📦', label: 'Количество' },
  orders_records: { emoji: '⚡', label: 'Рекорды' },
  cash: { emoji: '💰', label: 'Выручка' },
  shifts_quantity: { emoji: '🔢', label: 'Количество' },
  shifts_schedule: { emoji: '🕐', label: 'Расписание' },
  docs_route: { emoji: '📸', label: 'Маршрутники' },
  docs_recon: { emoji: '📊', label: 'Сверки' },
  docs_cash: { emoji: '💵', label: 'Наличные' },
  docs_mileage: { emoji: '🚗', label: 'Пробег' },
  special: { emoji: '⭐', label: 'Особые' }
};

const CATEGORY_SUBCATEGORIES = {
  orders: ['orders_quantity', 'orders_records'],
  shifts: ['shifts_quantity', 'shifts_schedule'],
  docs: ['docs_route', 'docs_recon', 'docs_cash', 'docs_mileage'],
  special: ['special'],
  cash: ['cash']
};

const ACHIEVEMENT_ORDER = {
  orders_quantity: ['orders_50', 'orders_300', 'orders_1000', 'orders_5000'],
  orders_records: ['orders_25', 'express_30', 'express_35', 'express_40'],
  cash: ['cash_10k', 'cash_500k', 'cash_1m'],
  shifts_quantity: ['first_shift', 'shifts_30', 'shifts_200', 'shifts_500'],
  shifts_schedule: ['early_start_50', 'late_finish_50'],
  docs_route: ['first_route', 'route_50', 'route_100', 'route_200'],
  docs_recon: ['first_rec', 'rec_30', 'rec_50', 'rec_100'],
  docs_cash: ['first_cash', 'cash_submit_50', 'cash_submit_100'],
  docs_mileage: ['first_mileage', 'mileage_50', 'mileage_100', 'mileage_200'],
  special: ['top1_day', 'early_bird', 'night_owl', 'perfect_shift', 'streak_7', 'streak_14', 'streak_30', 'top1_5', 'top1_10', 'top1_20']
};

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
  { id: 'shifts_500', name: 'Ветеран', desc: '500 смен', condition: { type: 'shifts', value: 500 }, reward: 2000 },
  { id: 'early_start_50', name: 'Ранний старт', desc: '50 смен начаты до 09:00', condition: { type: 'early_start', value: 50 }, reward: 300 },
  { id: 'late_finish_50', name: 'Поздний финиш', desc: '50 смен закончены после 22:00', condition: { type: 'late_finish', value: 50 }, reward: 300 },

  // Маршрутники
  { id: 'first_route', name: 'Первый маршрутник', desc: 'Отправить первый маршрутник', condition: { type: 'route_sheets', value: 1 }, reward: 50 },
  { id: 'route_50', name: 'Бумажный волк', desc: '50 маршрутников', condition: { type: 'route_sheets', value: 50 }, reward: 200 },
  { id: 'route_100', name: 'Бумажный тигр', desc: '100 маршрутников', condition: { type: 'route_sheets', value: 100 }, reward: 400 },
  { id: 'route_200', name: 'Бумажный лев', desc: '200 маршрутников', condition: { type: 'route_sheets', value: 200 }, reward: 1200 },

  // Сверки
  { id: 'first_rec', name: 'Первый сверщик', desc: 'Первая сверка', condition: { type: 'reconciliations', value: 1 }, reward: 50 },
  { id: 'rec_30', name: 'Сверщик-эксперт', desc: '30 сверок', condition: { type: 'reconciliations', value: 30 }, reward: 200 },
  { id: 'rec_50', name: 'Сверщик-мастер', desc: '50 сверок', condition: { type: 'reconciliations', value: 50 }, reward: 400 },
  { id: 'rec_100', name: 'Сверщик-легенда', desc: '100 сверок', condition: { type: 'reconciliations', value: 100 }, reward: 1200 },

  // Наличные
  { id: 'first_cash', name: 'Первые деньги', desc: 'Первая сдача наличных', condition: { type: 'cash_submits', value: 1 }, reward: 50 },
  { id: 'cash_submit_50', name: 'Кассир', desc: '50 сдач наличных', condition: { type: 'cash_submits', value: 50 }, reward: 200 },
  { id: 'cash_submit_100', name: 'Главный кассир', desc: '100 сдач наличных', condition: { type: 'cash_submits', value: 100 }, reward: 500 },

  // Пробег (только авто)
  { id: 'first_mileage', name: 'Первый пробег', desc: 'Первая запись пробега', condition: { type: 'mileage_records', value: 1, courierType: 'auto' }, reward: 50 },
  { id: 'mileage_50', name: 'Заправка', desc: '50 записей пробега', condition: { type: 'mileage_records', value: 50, courierType: 'auto' }, reward: 200 },
  { id: 'mileage_100', name: 'Полный бак', desc: '100 записей пробега', condition: { type: 'mileage_records', value: 100, courierType: 'auto' }, reward: 400 },
  { id: 'mileage_200', name: 'Заправщик', desc: '200 записей пробега', condition: { type: 'mileage_records', value: 200, courierType: 'auto' }, reward: 1200 },

  // Экспресс-заказы
  { id: 'express_30', name: 'Экспресс', desc: '30+ заказов за смену', condition: { type: 'orders_single', value: 30 }, reward: 500 },
  { id: 'express_35', name: 'Супер-экспресс', desc: '35+ заказов за смену', condition: { type: 'orders_single', value: 35 }, reward: 700 },
  { id: 'express_40', name: 'Молния', desc: '40+ заказов за смену', condition: { type: 'orders_single', value: 40 }, reward: 1500 },

  // Топ-1
  { id: 'top1_5', name: 'Король дня', desc: '5 раз топ-1', condition: { type: 'top1_count', value: 5 }, reward: 300 },
  { id: 'top1_10', name: 'Император', desc: '10 раз топ-1', condition: { type: 'top1_count', value: 10 }, reward: 600 },
  { id: 'top1_20', name: 'Бог рейтинга', desc: '20 раз топ-1', condition: { type: 'top1_count', value: 20 }, reward: 1000 },

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

const RARITY_TIERS = {
  diamond: { emoji: '👑', label: 'Легенда', min: 2000 },
  platinum: { emoji: '💎', label: 'Платина', min: 1200 },
  gold: { emoji: '🥇', label: 'Золото', min: 700 },
  silver: { emoji: '🥈', label: 'Серебро', min: 200 },
  bronze: { emoji: '🥉', label: 'Бронза', min: 0 }
};

const RARITY_ORDER = ['diamond', 'platinum', 'gold', 'silver', 'bronze'];

function getRarityTier(reward) {
  if (reward >= 2000) return 'diamond';
  if (reward >= 1200) return 'platinum';
  if (reward >= 700) return 'gold';
  if (reward >= 200) return 'silver';
  return 'bronze';
}

function getRarityCounts(telegramId) {
  const stats = getAchievementStats(telegramId);
  const unlockedIds = new Set(getUnlockedAchievements(telegramId).map(a => a.id));
  const counts = { diamond: 0, platinum: 0, gold: 0, silver: 0, bronze: 0 };
  const totals = { diamond: 0, platinum: 0, gold: 0, silver: 0, bronze: 0 };

  for (const ach of ACHIEVEMENTS) {
    if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) continue;
    const tier = getRarityTier(ach.reward);
    totals[tier]++;
    if (unlockedIds.has(ach.id)) counts[tier]++;
  }

  return { counts, totals };
}

function getBestAchievements(telegramId, count) {
  const unlocked = getUnlockedAchievements(telegramId);
  return unlocked
    .sort((a, b) => (b.reward || 0) - (a.reward || 0))
    .slice(0, count || 3);
}

function getNextAchievement(telegramId) {
  const stats = getAchievementStats(telegramId);
  const unlockedIds = new Set(getUnlockedAchievements(telegramId).map(a => a.id));
  let best = null;
  let bestPct = -1;

  for (const ach of ACHIEVEMENTS) {
    if (unlockedIds.has(ach.id)) continue;
    if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) continue;
    const progress = getConditionProgress(stats, ach.condition);
    if (progress.isBoolean || progress.target <= 0) continue;
    const pct = progress.current / progress.target;
    if (pct > bestPct) {
      bestPct = pct;
      best = { ...ach, progress };
    }
  }

  return best;
}

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
  return '▓'.repeat(filled) + '░'.repeat(empty);
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
    const msg = formatUnlockNotification(ach);
    await sendMsg(telegramId, msg);
  }
}

function _countCategoryAchievements(catKey, stats, unlockedIds) {
  const subs = CATEGORY_SUBCATEGORIES[catKey] || [];
  let total = 0;
  let done = 0;
  let catXp = 0;
  let catEarned = 0;

  for (const subKey of subs) {
    const order = ACHIEVEMENT_ORDER[subKey] || [];
    for (const achId of order) {
      const ach = ACHIEVEMENTS.find(a => a.id === achId);
      if (!ach) continue;
      if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) continue;
      total++;
      catXp += ach.reward || 0;
      if (unlockedIds.has(ach.id)) {
        done++;
        catEarned += ach.reward || 0;
      }
    }
  }

  return { total, done, catXp, catEarned };
}

function formatAchievementsCard(telegramId, category) {
  const stats = getAchievementStats(telegramId);
  const unlocked = getUnlockedAchievements(telegramId);
  const unlockedIds = new Set(unlocked.map(a => a.id));
  const catInfo = CATEGORY_MAP[category];

  const { total, done, catXp, catEarned } = _countCategoryAchievements(category, stats, unlockedIds);

  let text = `${catInfo.emoji} <b>${catInfo.label}</b>\n`;
  text += `${done}/${total} получено • ${catEarned}/${catXp} XP\n`;

  const subs = CATEGORY_SUBCATEGORIES[category] || [];

  for (const subKey of subs) {
    const subInfo = SUBCATEGORY_MAP[subKey] || { emoji: '📌', label: subKey };
    const order = ACHIEVEMENT_ORDER[subKey] || [];
    const achievements = [];
    for (const achId of order) {
      const ach = ACHIEVEMENTS.find(a => a.id === achId);
      if (!ach) continue;
      if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) continue;
      achievements.push(ach);
    }

    if (achievements.length === 0) continue;

    const showSubHeader = subs.length > 1;

    if (showSubHeader) {
      let subDone = 0;
      for (const ach of achievements) {
        if (unlockedIds.has(ach.id)) subDone++;
      }
      text += `\n${subInfo.emoji} <b>${subInfo.label}</b> ${subDone}/${achievements.length}\n`;
    }

    let nextActive = null;
    let nextProgress = null;
    for (const ach of achievements) {
      if (unlockedIds.has(ach.id)) continue;
      const progress = getConditionProgress(stats, ach.condition);
      if (!progress.isBoolean && progress.target > 0 && progress.current > 0) {
        nextActive = ach;
        nextProgress = progress;
        break;
      }
    }

    for (const ach of achievements) {
      const isDone = unlockedIds.has(ach.id);
      const isBlocked = ach.condition.courierType && ach.condition.courierType !== stats.courierType;
      const progress = getConditionProgress(stats, ach.condition);

      if (isDone) {
        text += `✅ <b>${ach.name}</b>\n`;
        text += `   ${ach.desc}\n`;
        text += `   🎉 +${ach.reward} XP\n`;
      } else if (isBlocked) {
        text += `🔒 <b>${ach.name}</b>\n`;
        text += `   ${ach.desc}\n`;
      } else {
        text += `⏳ <b>${ach.name}</b>\n`;
        text += `   ${ach.desc}\n`;
        if (!progress.isBoolean && progress.target > 0) {
          const bar = formatProgressBar(progress.current, progress.target);
          text += `   ${bar} ${progress.current.toLocaleString('ru-RU')}/${progress.target.toLocaleString('ru-RU')}\n`;
        }
        if (ach === nextActive && nextProgress) {
          const remaining = nextProgress.target - nextProgress.current;
          text += `   💡 ${remaining.toLocaleString('ru-RU')} до следующего!\n`;
        }
        text += `   Награда: +${ach.reward} XP\n`;
      }
    }
  }

  return text.trim();
}

function formatShowcase(telegramId) {
  const stats = getAchievementStats(telegramId);
  const unlocked = getUnlockedAchievements(telegramId);
  const unlockedIds = new Set(unlocked.map(a => a.id));
  const { counts, totals } = getRarityCounts(telegramId);
  const best = getBestAchievements(telegramId, 1)[0];
  const next = getNextAchievement(telegramId);

  let totalAll = 0;
  let doneAll = 0;
  let totalXp = 0;
  let earnedXp = 0;
  for (const ach of ACHIEVEMENTS) {
    if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) continue;
    totalAll++;
    totalXp += ach.reward || 0;
    if (unlockedIds.has(ach.id)) {
      doneAll++;
      earnedXp += ach.reward || 0;
    }
  }

  let text = `╔═══════════════════════╗\n`;
  text += `   🏆 <b>ТРОФЕЙНАЯ КОМНАТА</b>\n`;
  text += `╚═══════════════════════╝\n\n`;
  text += `🏅 <b>${doneAll}</b> / ${totalAll} медалей  •  <b>${earnedXp.toLocaleString('ru-RU')}</b> XP\n\n`;

  const tierLine1 = `🥉 <code>${formatProgressBar(counts.bronze, totals.bronze)}</code> ${counts.bronze}`;
  const tierLine2 = `🥈 <code>${formatProgressBar(counts.silver, totals.silver)}</code> ${counts.silver}`;
  const tierLine3 = `🥇 <code>${formatProgressBar(counts.gold, totals.gold)}</code> ${counts.gold}`;
  const tierLine4 = `💎 <code>${formatProgressBar(counts.platinum, totals.platinum)}</code> ${counts.platinum}`;
  text += `${tierLine1}   ${tierLine2}\n`;
  text += `${tierLine3}   ${tierLine4}\n`;

  if (best) {
    const tier = RARITY_TIERS[getRarityTier(best.reward)];
    text += `\n🌟 <b>Лучший трофей:</b> ${best.name}\n`;
    text += `   ${best.desc} • ${tier.emoji} +${best.reward.toLocaleString('ru-RU')} XP\n`;
  }

  if (next) {
    const tier = RARITY_TIERS[getRarityTier(next.reward)];
    const pct = next.progress.target > 0 ? Math.round((next.progress.current / next.progress.target) * 100) : 0;
    text += `\n⏭ <b>Ближайший:</b> ${next.name} ${tier.emoji}\n`;
    text += `   <code>${formatProgressBar(next.progress.current, next.progress.target)}</code> ${next.progress.current.toLocaleString('ru-RU')}/${next.progress.target.toLocaleString('ru-RU')}\n`;
  }

  return text.trim();
}

function formatRarityGallery(telegramId, tierKey) {
  const stats = getAchievementStats(telegramId);
  const unlocked = getUnlockedAchievements(telegramId);
  const unlockedIds = new Set(unlocked.map(a => a.id));
  const tier = RARITY_TIERS[tierKey];

  const achievements = ACHIEVEMENTS.filter(ach => {
    if (ach.condition.courierType && ach.condition.courierType !== stats.courierType) return false;
    return getRarityTier(ach.reward) === tierKey;
  });

  let done = 0;
  for (const ach of achievements) {
    if (unlockedIds.has(ach.id)) done++;
  }

  let text = `${tier.emoji} <b>${tier.label.toUpperCase()}Е ТРОФЕИ</b>  ${done} / ${achievements.length}\n`;

  for (const ach of achievements) {
    const isDone = unlockedIds.has(ach.id);
    const isBlocked = ach.condition.courierType && ach.condition.courierType !== stats.courierType;
    const progress = getConditionProgress(stats, ach.condition);

    text += `\n`;

    if (isDone) {
      const unlockedAch = unlocked.find(u => u.id === ach.id);
      text += `✅ <b>${ach.name}</b> — ${ach.desc}\n`;
      text += `   🎉 +${ach.reward.toLocaleString('ru-RU')} XP`;
      if (unlockedAch?.unlockedAt) {
        const d = new Date(unlockedAch.unlockedAt);
        text += ` · 📅 ${d.toLocaleDateString('ru-RU')}`;
      }
      text += `\n`;
    } else if (isBlocked) {
      text += `🔒 <b>${ach.name}</b> — ${ach.desc}\n`;
      text += `   Награда: +${ach.reward.toLocaleString('ru-RU')} XP\n`;
    } else {
      text += `⏳ <b>${ach.name}</b> — ${ach.desc}\n`;
      if (!progress.isBoolean && progress.target > 0) {
        text += `   <code>${formatProgressBar(progress.current, progress.target)}</code> ${progress.current.toLocaleString('ru-RU')}/${progress.target.toLocaleString('ru-RU')}\n`;
      }
      text += `   Награда: +${ach.reward.toLocaleString('ru-RU')} XP\n`;
    }
  }

  return text.trim();
}

function formatTrophyCard(telegramId, achievementId) {
  const ach = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!ach) return '❌ Достижение не найдено';

  const stats = getAchievementStats(telegramId);
  const isDone = isAchievementUnlocked(telegramId, ach.id);
  const progress = getConditionProgress(stats, ach.condition);
  const tierKey = getRarityTier(ach.reward);
  const tier = RARITY_TIERS[tierKey];

  let text = `╔═══════════════════════╗\n`;
  text += `   ${tier.emoji} <b>${ach.name.toUpperCase()}</b>\n`;
  text += `   ${tier.emoji} ${tier.label} · +${ach.reward.toLocaleString('ru-RU')} XP\n`;
  text += `╚═══════════════════════╝\n\n`;
  text += `${ach.desc}\n\n`;

  if (!progress.isBoolean && progress.target > 0) {
    text += `<code>${formatProgressBar(progress.current, progress.target)}</code> ${progress.current.toLocaleString('ru-RU')} / ${progress.target.toLocaleString('ru-RU')}\n`;
    if (!isDone) {
      const remaining = progress.target - progress.current;
      text += `💡 ${remaining.toLocaleString('ru-RU')} до следующего!\n`;
    }
    text += `\n`;
  }

  if (isDone) {
    const unlocked = getUnlockedAchievements(telegramId).find(u => u.id === ach.id);
    text += `Статус: ✅ Получено\n`;
    if (unlocked?.unlockedAt) {
      const d = new Date(unlocked.unlockedAt);
      text += `Дата: 📅 ${d.toLocaleDateString('ru-RU')}\n`;
    }
  } else {
    text += `Статус: ⏳ В процессе\n`;
  }

  return text.trim();
}

function formatUnlockNotification(achievement) {
  const tierKey = getRarityTier(achievement.reward);
  const tier = RARITY_TIERS[tierKey];

  let text = `🎉🏆🎉\n\n`;
  text += `🏅 <b>МЕДАЛЬ ПОЛУЧЕНА!</b>\n\n`;
  text += `${tier.emoji} <b>${achievement.name.toUpperCase()}</b>\n`;
  text += `<i>${achievement.desc}</i>\n\n`;
  text += `Раритет: ${tier.emoji} ${tier.label}\n`;
  text += `Награда: +${achievement.reward.toLocaleString('ru-RU')} XP\n\n`;
  text += `🔥 Отличная работа!`;

  return text;
}

module.exports = {
  getAllAchievements,
  getUnlockedAchievements,
  isAchievementUnlocked,
  unlockAchievement,
  checkMilestoneAchievements,
  getAchievementStats,
  notifyAchievements,
  formatProgressBar,
  formatAchievementsCard,
  formatShowcase,
  formatRarityGallery,
  formatTrophyCard,
  formatUnlockNotification,
  getRarityTier,
  getRarityCounts,
  getBestAchievements,
  getNextAchievement,
  RARITY_TIERS,
  RARITY_ORDER,
  CATEGORY_MAP,
  SUBCATEGORY_MAP,
  ACHIEVEMENT_ORDER
};
