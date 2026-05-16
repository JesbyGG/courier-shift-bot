require('dotenv').config();
require('./logger').initLogger();

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const crypto = require('crypto');

const { Telegraf, Markup } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const {
  initGoogleSheets,
  findCourierInAllSheets,
  punchTime,
  prepareMileage,
  replaceTime,
  updateCourierTime,
  updateMileage,
  readCell,
  getSheetConfig,
  updateEfficiencyOrders
} = require('./services/googleSheets');
const {
  getUserField,
  getFullProfile,
  setUserField,
  getUserRole,
  deleteUser,
  clearPendingCashToSubmit,
  setCashConfirmationStatus,
  clearPendingCashAndReminders,
  getAllUserIds,
  resolveSheetInfo,
  flushNow: flushStorageNow,
  getSheetAccessUsers,
  addSheetAccessUser,
  removeSheetAccessUser,
  isSheetAccessUser,
  markUserSeen,
  cleanupOldMonths,
  getCurrentMonthKey,
  getNextMonthKey,
  getWorkplaceSheetIdByMonth,
  logCashAction,
  getCashHistory,
  getDebtors,
  findLogistsForWorkplace,
  setReminder,
  getReminder,
  updateReminder,
  deleteReminder,
  getActiveRemindersForCourier,
  getSelfClearanceRequest,
  cleanupStaleReminders
} = require('./services/storage');
const { recognizeMileage, isRapidOcrEnabled, recognizeTextWithRapidOcr, getMinMileageThreshold } = require('./services/mileageOcr');
const { recordOrders: recordLeaderboardOrders, calculateLeaderboard, formatLeaderboard, checkNotifications: checkLeaderboardNotifications, flushNow: flushLeaderboardNow } = require('./services/leaderboard');
const { getCurrentDateInfo, getColumnLetter, getMileageColumnsByDay, roundMinutesToHalfHour } = require('./utils');
const { registerSheetCommand } = require('./sheetCommand');
const { WORKPLACES, DEVICES, ROLES, LIMITS } = require('./config');

const db = require('./db');

function getState(telegramId) {
  const row = db.prepare('SELECT data FROM states WHERE telegramId = ?').get(String(telegramId));
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function setState(telegramId, state) {
  const stmt = db.prepare('INSERT OR REPLACE INTO states (telegramId, data) VALUES (?, ?)');
  stmt.run(String(telegramId), JSON.stringify(state));
}

function clearState(telegramId) {
  db.prepare('DELETE FROM states WHERE telegramId = ?').run(String(telegramId));
}

function flushStateNow() {
  // SQLite WAL is persistent.
}

const versionPath = path.join(__dirname, 'version.json');
const changelogPath = path.join(__dirname, 'changelog.json');
const _sourceDir = __dirname;

function _getCurrentVersion() {
  try {
    if (!fs.existsSync(versionPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  } catch {
    return null;
  }
}

function _getSourceFiles() {
  return fs.readdirSync(_sourceDir)
    .filter((f) => f.endsWith('.js') && f !== 'version.js')
    .sort();
}

function _computeSourceSnapshot() {
  const jsFiles = _getSourceFiles();
  const fileHashes = {};
  const combinedHash = crypto.createHash('sha256');
  for (const file of jsFiles) {
    const filePath = path.join(_sourceDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const fileHash = crypto.createHash('sha256').update(content).digest('hex');
      fileHashes[file] = fileHash;
      combinedHash.update(file);
      combinedHash.update(fileHash);
    } catch {
    }
  }
  return {
    hash: combinedHash.digest('hex'),
    files: fileHashes
  };
}

function _getChangedFiles(previousFiles, currentFiles) {
  const prev = previousFiles || {};
  const next = currentFiles || {};
  const allFiles = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...allFiles]
    .filter((file) => prev[file] !== next[file])
    .sort();
}

function _bumpVersion(version, bumpType) {
  const parts = version.split('.').map(Number);
  if (bumpType === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (bumpType === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    parts[2] = (parts[2] || 0) + 1;
  }
  return parts.join('.');
}

function checkVersion() {
  const snapshot = _computeSourceSnapshot();
  const currentHash = snapshot.hash;
  const currentFiles = snapshot.files;
  const stored = _getCurrentVersion();
  if (!stored) {
    const initialVersion = '2.0.0';
    const data = {
      version: initialVersion,
      lastHash: currentHash,
      files: currentFiles,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf8');
    return {
      version: initialVersion,
      changed: true,
      prevVersion: null,
      changedFiles: Object.keys(currentFiles).sort()
    };
  }
  if (stored.lastHash === currentHash) {
    return { version: stored.version, changed: false, prevVersion: null, changedFiles: [] };
  }
  const changedFiles = _getChangedFiles(stored.files, currentFiles);
  const bumpType = getChangelogBump();
  const newVersion = _bumpVersion(stored.version, bumpType);
  const data = {
    version: newVersion,
    lastHash: currentHash,
    files: currentFiles,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`version bumped: ${stored.version} → ${newVersion} (${bumpType})`);
  return { version: newVersion, changed: true, prevVersion: stored.version, changedFiles };
}

function getVersion() {
  const stored = _getCurrentVersion();
  return stored ? stored.version : '2.0.0';
}

const BUTTONS = {
  punchTime: '⏱ Записать время',
  mileage: '🚗 Фото пробега',
  routeSheet: '📄 Отправить маршрутник',
  reconciliation: '📊 Отправить сверку',
  cashCheck: '💵 Сдать наличные',
  issues: '⚠️ Проблема с заказом',
  leaderBoard: '🏆 Рейтинг',
  settings: '⚙️ Настройки',
  help: '❓ Помощь',
  profile: '✏️ Профиль',
  changeCar: '✏️ Изменить номер машины',
  changeWorkplace: '✏️ Поменять магазин',
  changeDevice: '✏️ Изменить устройство',
  switchUser: '✏️ Поменять сотрудника',
  sheetInfo: '📋 Таблицы',
  myId: '🆔 Мой ID',
  cashCollect: '💳 Принять наличные',
  cashHistory: '📋 История сборов',
  backToSettings: '↩️ К настройкам',
  back: '🏠 В меню'
};

// WORKPLACES, DEVICES — теперь из config.js (см. импорт выше)

function mainMenu() {
  return Markup.keyboard([
    [BUTTONS.punchTime, BUTTONS.mileage],
    [BUTTONS.routeSheet, BUTTONS.reconciliation],
    [BUTTONS.cashCheck, BUTTONS.issues],
    [BUTTONS.leaderBoard, BUTTONS.settings]
  ]).resize();
}

function settingsMenu(telegramId) {
  return getSettingsMenuForRole(telegramId);
}

function profileMenu() {
  return Markup.keyboard([
    [BUTTONS.changeCar, BUTTONS.changeWorkplace],
    [BUTTONS.changeDevice, BUTTONS.switchUser],
    [BUTTONS.backToSettings]
  ]).resize();
}

function workplaceMenu() {
  return Markup.keyboard([
    WORKPLACES,
    [BUTTONS.back]
  ]).resize();
}

function deviceMenu() {
  return Markup.keyboard([
    DEVICES,
    [BUTTONS.back]
  ]).resize();
}

function logistMainMenu() {
  return Markup.keyboard([
    [BUTTONS.punchTime],
    [BUTTONS.cashCollect],
    [BUTTONS.sheetInfo, BUTTONS.settings]
  ]).resize();
}

function logistSettingsMenu() {
  return Markup.keyboard([
    [BUTTONS.profile],
    [BUTTONS.myId],
    [BUTTONS.cashHistory],
    [BUTTONS.help],
    [BUTTONS.back]
  ]).resize();
}

function logistProfileMenu() {
  return Markup.keyboard([
    [BUTTONS.changeWorkplace, BUTTONS.switchUser],
    [BUTTONS.backToSettings]
  ]).resize();
}

function getMenuForRole(telegramId) {
  const role = getUserRole(telegramId);
  return role === 'logist' ? logistMainMenu() : mainMenu();
}

function getSettingsMenuForRole(telegramId) {
  const role = getUserRole(telegramId);
  if (role === 'logist') {
    return logistSettingsMenu();
  }
  return settingsMenu(telegramId);
}

function getProfileMenuForRole(telegramId) {
  const role = getUserRole(telegramId);
  if (role === 'logist') {
    return logistProfileMenu();
  }
  return profileMenu();
}

function roleChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👤 Курьер', 'role_courier')],
    [Markup.button.callback('📦 Логист', 'role_logist')]
  ]);
}

function isLogist(telegramId) {
  return getUserRole(telegramId) === 'logist';
}

function requireRole(ctx, requiredRole) {
  const role = getUserRole(ctx.from.id);
  if (requiredRole === 'courier' && role === 'logist') {
    ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return false;
  }
  if (requiredRole === 'logist' && role !== 'logist') {
    ctx.replyWithHTML('❌ Эта функция доступна только логистам.', getMenuForRole(ctx.from.id));
    return false;
  }
  return true;
}

function skipMileageKeyboard() {
  // Раньше тут была одна кнопка «Пропустить» — если у курьера нет камеры,
  // он застрял бы. Теперь альтернатива «Ввести вручную» сразу под рукой.
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Ввести вручную', 'edit_mileage')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function mileageConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷 Загрузить фото повторно', 'retry_mileage_photo')],
    [Markup.button.callback('✏️ Ввести вручную', 'edit_mileage')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function mileageSavedKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить пробег', 'edit_mileage')]
  ]);
}

function routeSheetKeyboard() {
  // «Завершить» — явный сигнал «закончил отправлять фото», убирает
  // двусмысленность кнопки «В меню» (которая выглядит как отмена).
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Завершить', 'route_sheet_done'),
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function manualMileageKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷 Загрузить фото повторно', 'retry_mileage_photo')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function replaceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Изменить начало', 'replace_start')],
    [Markup.button.callback('🔴 Изменить конец', 'replace_end')],
    [Markup.button.callback('❌ Отмена', 'back_to_menu')]
  ]);
}

function timeChangeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить время', 'edit_time')]
  ]);
}

function mileageReplaceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Изменить пробег начала', 'replace_mileage_start')],
    [Markup.button.callback('🔴 Изменить пробег конца', 'replace_mileage_end')],
    [Markup.button.callback('❌ Отмена', 'back_to_menu')]
  ]);
}

function switchUserKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, сменить', 'confirm_switch_user')],
    [Markup.button.callback('❌ Отмена', 'back_to_menu')]
  ]);
}

function cashSubmitConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, сдал', 'cash_submit_yes')],
    [Markup.button.callback('❌ Нет, не сдал', 'cash_submit_no')],
    [Markup.button.callback('🏠 В меню', 'back_to_menu')]
  ]);
}

function debtorListKeyboard(debtors, logistWorkplace) {
  const buttons = [];
  for (const debtor of debtors) {
    const activeReminders = getActiveRemindersForCourier(debtor.telegramId);
    let label = `👤 ${debtor.fio} — ${debtor.formatted || debtor.amount} ₽`;
    if (activeReminders.length > 0) {
      const remindedBy = activeReminders.map(r => r.logistFio).join(', ');
      label += ` 🔔(${remindedBy})`;
    }
    const selfClearance = getSelfClearanceRequest(debtor.telegramId);
    if (selfClearance) {
      label = `👤 ${debtor.fio} — ${selfClearance.formatted || selfClearance.amount} ₽ ⏳`;
    }
    buttons.push([Markup.button.callback(label, `d_${debtor.telegramId}`)]);
  }
  if (buttons.length === 0) {
    return null;
  }
  buttons.push([Markup.button.callback('🏠 В меню', 'back_to_menu')]);
  return Markup.inlineKeyboard(buttons);
}

async function showDebtorsList(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== 'logist') {
    await ctx.replyWithHTML('❌ Эта функция доступна только логистам.', getMenuForRole(telegramId));
    return;
  }

  const workplace = getUserField(telegramId, 'workplace');
  if (!workplace) {
    await ctx.replyWithHTML('⚠️ Сначала выберите магазин в настройках.', getSettingsMenuForRole(telegramId));
    return;
  }

  cleanupStaleReminders();

  const debtors = getDebtors(workplace);

  if (debtors.length === 0) {
    await ctx.replyWithHTML('✅ Все деньги сданы, долгов нет.', getMenuForRole(telegramId));
    return;
  }

  const totalAmount = debtors.reduce((sum, d) => sum + d.amount, 0);
  const formattedTotal = formatMoneyRu(totalAmount);

  await ctx.replyWithHTML(
    `💳 <b>Курьеры с долгами</b> (${esc(workplace)})\n` +
    `Всего к сдаче: <code>${formattedTotal}</code> ₽\n\n` +
    `Нажмите на курьера, чтобы отправить напоминание:`,
    debtorListKeyboard(debtors, workplace)
  );
}

async function pokeCourier(ctx, courierId) {
  const logistId = ctx.from.id;
  const logistFio = getUserField(logistId, 'fio') || 'Логист';
  const logistWorkplace = getUserField(logistId, 'workplace');
  const courierRecord = getUserField(courierId, 'fio') ? {
    fio: getUserField(courierId, 'fio'),
    workplace: getUserField(courierId, 'workplace')
  } : null;

  if (!courierRecord || !courierRecord.fio) {
    await ctx.answerCbQuery('⚠️ Курьер не найден.');
    return;
  }

  const selfClearance = getSelfClearanceRequest(courierId);
  if (selfClearance) {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `⏳ ${esc(courierRecord.fio)} уже отметил сдачу.\n` +
      `Ожидает подтверждения: <code>${esc(selfClearance.formatted || String(selfClearance.amount))}</code> ₽`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтвердить', `sc_appr_${courierId}`)],
        [Markup.button.callback('❌ Отклонить', `sc_decl_${courierId}`)]
      ])
    );
    return;
  }

  const pendingCash = getUserField(courierId, 'pendingCashToSubmit');
  const amount = Number(pendingCash?.amount || 0);
  if (!Number.isFinite(amount) || amount < 1) {
    await ctx.answerCbQuery('✅ Курьер уже сдал деньги.');
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText('✅ Курьер уже сдал деньги.'); } catch (e) { /* ignore */ }
    }
    return;
  }

  const formatted = pendingCash?.formatted || formatMoneyRu(amount);
  const shortId = crypto.randomBytes(4).toString('hex');

  const reminderData = {
    logistId: String(logistId),
    logistChatId: String(logistId),
    logistFio: logistFio,
    courierId: String(courierId),
    courierFio: courierRecord.fio,
    amount: amount,
    formatted: formatted,
    workplace: courierRecord.workplace || logistWorkplace,
    status: 'reminded',
    createdAt: new Date().toISOString(),
    logistMsgId: null,
    courierMsgId: null
  };

  setReminder(shortId, reminderData);

  logCashAction({
    logistId: String(logistId),
    logistFio: logistFio,
    courierId: String(courierId),
    courierFio: courierRecord.fio,
    workplace: courierRecord.workplace || logistWorkplace,
    amount: amount,
    action: 'reminded'
  });

  const workpalceLabel = courierRecord.workplace || 'не указано';
  const courierMsg = `🔔 <b>Логист ${esc(logistFio)} напоминает:</b>\n\n` +
    `💵 У вас <code>${esc(formatted)}</code> ₽ к сдаче.\n` +
    `🏬 <b>${esc(workpalceLabel)}</b>\n\n` +
    `Сдали деньги?`;

  try {
    const sent = await bot.telegram.sendMessage(courierId, courierMsg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('🏃 Уже бегу', `ack_${shortId}`)],
          [Markup.button.callback('✅ Сдал', `c_${shortId}`)]
        ]
      }
    });

    const msgId = sent.message_id;
    updateReminder(shortId, { courierMsgId: msgId });

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('✅ Напоминание отправлено');
      try {
        await ctx.editMessageText(`✅ Напоминание отправлено: <b>${esc(courierRecord.fio)}</b> — <code>${esc(formatted)}</code> ₽`, { parse_mode: 'HTML' });
      } catch (e) { /* ignore */ }
    } else {
      await ctx.replyWithHTML(`✅ Напоминание отправлено: <b>${esc(courierRecord.fio)}</b> — <code>${esc(formatted)}</code> ₽`);
    }
  } catch (e) {
    console.error('failed to send reminder to courier', e);
    deleteReminder(shortId);
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('⚠️ Не удалось отправить уведомление курьеру.');
    } else {
      await ctx.replyWithHTML('⚠️ Не удалось отправить уведомление курьеру. Возможно, он заблокировал бота.');
    }
  }
}

async function showCashHistory(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== 'logist') {
    await ctx.replyWithHTML('❌ Эта функция доступна только логистам.', getMenuForRole(telegramId));
    return;
  }

  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const buttons = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayLabel = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone });
    const prefix = i === 0 ? '📅 ' : '';
    buttons.push([Markup.button.callback(`${prefix}${dayLabel}`, `ch_${dateStr}`)]);
  }
  buttons.push([Markup.button.callback('🏠 В меню', 'back_to_menu')]);

  await ctx.replyWithHTML('📋 <b>История сборов</b>\n\nВыберите дату:', Markup.inlineKeyboard(buttons));
}

async function showCashHistoryForDate(ctx, dateStr) {
  const telegramId = ctx.from.id;
  const workplace = getUserField(telegramId, 'workplace');
  const rows = getCashHistory(dateStr, workplace);

  const approvedRows = rows.filter(r => r.action === 'approved' || r.action === 'self_cleared');

  if (approvedRows.length === 0) {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(`📋 <b>История сборов за ${dateStr}</b>\n\nНет подтверждённых сдач за эту дату.`);
    return;
  }

  const total = approvedRows.reduce((sum, r) => sum + r.amount, 0);
  let msg = `📋 <b>История сборов за ${dateStr}</b>\n` +
    `Всего собрано: <code>${formatMoneyRu(total)}</code> ₽\n\n`;

  for (const row of approvedRows) {
    const icon = row.action === 'self_cleared' ? '💵' : '✅';
    const logistLabel = row.logistFio ? ` (логист: ${esc(row.logistFio)})` : ' (самостоятельно)';
    msg += `${icon} ${esc(row.courierFio)} — <code>${formatMoneyRu(row.amount)}</code> ₽${logistLabel}\n`;
  }

  await ctx.replyWithHTML(msg);
}

async function notifyLogistsAboutSelfClearance(courierId, courierFio, amount, formatted, workplace) {
  const logists = findLogistsForWorkplace(workplace);
  const adminIds = getAdminIds();

  const allRecipientIds = new Set();
  for (const logist of logists) {
    allRecipientIds.add(String(logist.telegramId));
  }
  for (const adminId of adminIds) {
    if (!allRecipientIds.has(String(adminId))) {
      allRecipientIds.add(String(adminId));
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Подтвердить', `sc_appr_${courierId}`)],
    [Markup.button.callback('❌ Отклонить', `sc_decl_${courierId}`)]
  ]);

  for (const recipientId of allRecipientIds) {
    try {
      await bot.telegram.sendMessage(recipientId,
        `💰 <b>Курьер отметил сдачу</b>\n\n` +
        `👤 ${esc(courierFio)}\n` +
        `💵 <code>${esc(formatted)}</code> ₽\n` +
        `🏬 ${esc(workplace)}\n\n` +
        `Подтвердите сдачу:`,
        { parse_mode: 'HTML', reply_markup: keyboard }
      );
    } catch (e) {
      console.error('failed to notify logist about self-clearance', recipientId, e.message);
    }
  }
}

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set');
}

function normalizeProxyUrl(value) {
  const text = String(value || '').trim();
  return text || null;
}

function createTelegramAgent() {
  const proxyUrl = normalizeProxyUrl(process.env.TELEGRAM_PROXY_URL)
    || normalizeProxyUrl(process.env.HTTPS_PROXY)
    || normalizeProxyUrl(process.env.HTTP_PROXY);

  if (!proxyUrl) return null;

  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch (_) {
    console.error('Invalid TELEGRAM_PROXY_URL, proxy disabled');
    return null;
  }

  const protocol = String(parsed.protocol || '').toLowerCase();

  if (protocol.startsWith('socks')) {
    console.log('Telegram proxy enabled (SOCKS)');
    return new SocksProxyAgent(proxyUrl);
  }

  if (protocol === 'http:' || protocol === 'https:') {
    console.log('Telegram proxy enabled (HTTP/HTTPS)');
    return new HttpsProxyAgent(proxyUrl);
  }

  console.error(`Unsupported TELEGRAM_PROXY_URL protocol: ${protocol}`);
  return null;
}

const telegramAgent = createTelegramAgent();
const bot = new Telegraf(process.env.BOT_TOKEN, telegramAgent ? {
  telegram: { agent: telegramAgent }
} : undefined);
const photoLogPath = path.join(__dirname, 'photo-log.jsonl');
const routeSheetLogPath = path.join(__dirname, 'route-sheet-log.jsonl');
const reconciliationLogPath = path.join(__dirname, 'reconciliation-log.jsonl');
const funReactionsPath = path.join(__dirname, 'fun-reactions.json');
const lastFunReactionAt = new Map();
const FUN_REACTION_CLEANUP_INTERVAL = LIMITS.FUN_REACTION_CLEANUP_INTERVAL_MS;
let funReactionCleanupTimer = null;

function cleanupFunReactionCooldowns() {
  const now = Date.now();
  for (const [key, ts] of lastFunReactionAt) {
    if (now - ts > FUN_REACTION_CLEANUP_INTERVAL) {
      lastFunReactionAt.delete(key);
    }
  }
}

function startFunReactionCleanup() {
  if (!funReactionCleanupTimer) {
    funReactionCleanupTimer = setInterval(cleanupFunReactionCooldowns, FUN_REACTION_CLEANUP_INTERVAL);
    funReactionCleanupTimer.unref();
  }
}

startFunReactionCleanup();

let funReactionsCache = null;
let funReactionsWriteScheduled = false;

const SUCCESS_STICKER_EMOJIS = new Set(['😀', '😁', '😄', '😎', '🥳', '🎉', '✨', '🔥', '💪', '👍', '👏', '✅']);
const ERROR_STICKER_EMOJIS = new Set(['😢', '😭', '😿', '😞', '😣', '😫', '🤦', '🙈', '😡', '😤', '🚫', '❌', '⚠️']);

function esc(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isButton(text, button, legacyText) {
  return text === button || text === legacyText;
}

function formatStage(stage) {
  return stage === 'start' ? 'начало смены' : 'конец смены';
}

function formatPhotoStatus(stage) {
  return stage === 'start' ? '🟢 Старт' : '🔴 Конец';
}

function getEmployeeDisplayName(fio) {
  const parts = String(fio || '').trim().split(/\s+/);
  if (parts.length >= 2) {
    return parts[1] + ' ' + parts[0];
  }
  return fio || '';
}

// Telegram ограничивает caption до 1024 символов (НЕ 4096 как для текста).
// Длинное ФИО + магазин могут превысить лимит, тогда API вернёт ошибку.
const TELEGRAM_CAPTION_LIMIT = LIMITS.TELEGRAM_CAPTION_LIMIT;

function truncateCaption(text, limit = TELEGRAM_CAPTION_LIMIT) {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

function buildPhotoCaption(state) {
  // Caption уходит без HTML-парсинга в sendPhotoToWorkChat — escape не нужен,
  // но если в ФИО окажутся <, > — пусть будут как есть, без поломки рендера.
  return truncateCaption([
    formatPhotoStatus(state.stage),
    `👤 ${getEmployeeDisplayName(state.fio)}`,
    `🚙 ${state.auto || 'не указано'}`,
    `🏬 ${state.workplace || 'не указано'}`
  ].join('\n'));
}

function buildRouteSheetCaption(state, routeSheetNumber) {
  return truncateCaption([
    `📄 Маршрутный лист №${routeSheetNumber}`,
    `👤 ${getEmployeeDisplayName(state.fio)}`,
    `🏬 ${state.workplace || 'не указано'}`
  ].join('\n'));
}

function getTodayText() {
  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  return getCurrentDateInfo(timezone).dateText;
}

const MAX_LOG_SIZE = LIMITS.MAX_LOG_SIZE_BYTES;

async function trimLogIfNeeded(filePath) {
  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size < MAX_LOG_SIZE) return;
    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const half = Math.ceil(lines.length / 2);
    const trimmed = lines.slice(-half).join('\n');
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, trimmed, 'utf8');
    await fs.promises.rename(tmp, filePath);
  } catch (_) {}
}

async function appendLog(filePath, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.promises.appendFile(filePath, line, 'utf8');
  } catch (error) {
    console.error('log write error', filePath, error.message);
  }
  await trimLogIfNeeded(filePath);
}

const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_FILES = ['database.sqlite', 'fun-reactions.json'];
const BACKUP_INTERVAL_MS = LIMITS.BACKUP_INTERVAL_MS;
const BACKUP_RETENTION_MS = LIMITS.BACKUP_RETENTION_MS;

async function ensureBackupDir() {
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  } catch (_) {}
}

async function makeBackup(reason = 'auto') {
  await ensureBackupDir();
  const now = new Date();
  const ts = now.toISOString().replace(/[.:]/g, '-');

  for (const filename of BACKUP_FILES) {
    const src = path.join(__dirname, filename);
    try {
      await fs.promises.access(src);
      const dst = path.join(BACKUP_DIR, `${filename.replace('.json', '')}-${reason}-${ts}.json`);
      await fs.promises.copyFile(src, dst);
    } catch (_) {}
  }
}

async function cleanOldBackups() {
  const cutoff = Date.now() - BACKUP_RETENTION_MS;
  let entries;
  try {
    entries = await fs.promises.readdir(BACKUP_DIR);
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(BACKUP_DIR, entry);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(fullPath);
      }
    } catch (_) {}
  }
}

async function runBackupCycle() {
  await makeBackup('auto');
  await cleanOldBackups();
}

function withTimeout(promise, timeoutMs, label) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseEnvList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickRandom(items) {
  if (!items || items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function mergeUniqueItems(...lists) {
  const result = [];
  const seen = new Set();

  for (const list of lists) {
    for (const item of list || []) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
  }

  return result;
}

function normalizeFunList(value, limit = 800) {
  return mergeUniqueItems(value).slice(0, limit);
}

function normalizeImportedStickerSets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};

  for (const [name, meta] of Object.entries(source)) {
    const setName = String(name || '').trim();
    if (!setName) continue;
    result[setName] = {
      importedAt: String(meta?.importedAt || ''),
      total: Number(meta?.total || 0)
    };
  }

  return result;
}

function getEmptyFunReactions() {
  return {
    successStickers: [],
    errorStickers: [],
    neutralStickers: [],
    successGifs: [],
    errorGifs: [],
    neutralGifs: [],
    importedStickerSets: {}
  };
}

function normalizeFunReactionsData(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    successStickers: normalizeFunList(source.successStickers),
    errorStickers: normalizeFunList(source.errorStickers),
    neutralStickers: normalizeFunList(source.neutralStickers),
    successGifs: normalizeFunList(source.successGifs, 300),
    errorGifs: normalizeFunList(source.errorGifs, 300),
    neutralGifs: normalizeFunList(source.neutralGifs, 300),
    importedStickerSets: normalizeImportedStickerSets(source.importedStickerSets)
  };
}

function loadFunReactions() {
  if (funReactionsCache) return funReactionsCache;

  try {
    if (!fs.existsSync(funReactionsPath)) {
      funReactionsCache = getEmptyFunReactions();
      return funReactionsCache;
    }

    const data = JSON.parse(fs.readFileSync(funReactionsPath, 'utf8'));
    funReactionsCache = normalizeFunReactionsData(data);
    return funReactionsCache;
  } catch (error) {
    console.error('fun reactions load error', error.message);
    funReactionsCache = getEmptyFunReactions();
    return funReactionsCache;
  }
}

function scheduleFunReactionsWrite() {
  if (funReactionsWriteScheduled) return;
  funReactionsWriteScheduled = true;

  setImmediate(() => {
    funReactionsWriteScheduled = false;
    fs.promises.writeFile(funReactionsPath, JSON.stringify(funReactionsCache || getEmptyFunReactions(), null, 2), 'utf8').catch((error) => {
      console.error('fun reactions write error', error.message);
    });
  });
}

function flushFunReactionsNow() {
  funReactionsWriteScheduled = false;

  try {
    fs.writeFileSync(funReactionsPath, JSON.stringify(funReactionsCache || getEmptyFunReactions(), null, 2), 'utf8');
  } catch (error) {
    console.error('fun reactions flush error', error.message);
  }
}

function addUniqueLimited(list, value, limit = 800) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (list.includes(text)) return false;

  list.push(text);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }

  return true;
}

function getStickerReactionTypeByEmoji(emoji) {
  const value = String(emoji || '').trim();
  if (!value) return 'neutral';
  if (ERROR_STICKER_EMOJIS.has(value)) return 'error';
  if (SUCCESS_STICKER_EMOJIS.has(value)) return 'success';
  return 'neutral';
}

function getStickerBucketByType(reactionType) {
  if (reactionType === 'error') return 'errorStickers';
  if (reactionType === 'success') return 'successStickers';
  return 'neutralStickers';
}

function getGifBucketByType(reactionType) {
  if (reactionType === 'error') return 'errorGifs';
  if (reactionType === 'success') return 'successGifs';
  return 'neutralGifs';
}

function saveFunSticker(fileId, reactionType = 'neutral') {
  const data = loadFunReactions();
  const bucket = getStickerBucketByType(reactionType);
  const changed = addUniqueLimited(data[bucket], fileId, 1000);

  if (changed) {
    scheduleFunReactionsWrite();
  }

  return changed;
}

function saveFunGif(fileId, reactionType = 'neutral') {
  const data = loadFunReactions();
  const bucket = getGifBucketByType(reactionType);
  const changed = addUniqueLimited(data[bucket], fileId, 400);

  if (changed) {
    scheduleFunReactionsWrite();
  }

  return changed;
}

function extractStickerSetName(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const match = value.match(/(?:https?:\/\/)?t\.me\/addstickers\/([a-zA-Z0-9_]+)/i);
  if (match) return match[1];

  if (/^[a-zA-Z0-9_]+$/.test(value)) return value;
  return null;
}

function isFunStickerSetImportEnabled() {
  return String(process.env.FUN_IMPORT_STICKER_SETS || 'true').toLowerCase() !== 'false';
}

function getConfiguredFunStickerSetNames() {
  const envItems = parseEnvList(process.env.FUN_STICKER_SETS);
  const defaults = [
    'https://t.me/addstickers/TikTok_cats_animals',
    'https://t.me/addstickers/babylka_mem'
  ];
  const sources = envItems.length > 0 ? envItems : defaults;

  return mergeUniqueItems(sources.map((item) => extractStickerSetName(item)).filter(Boolean));
}

async function importStickerSetForFunReactions(ctx, stickerSetName) {
  const setName = extractStickerSetName(stickerSetName);
  if (!setName || !isFunStickerSetImportEnabled()) {
    return { setName, imported: false, added: 0, total: 0 };
  }

  const data = loadFunReactions();
  if (data.importedStickerSets[setName]) {
    return { setName, imported: false, added: 0, total: data.importedStickerSets[setName].total || 0 };
  }

  try {
    const stickerSet = await ctx.telegram.getStickerSet(setName);
    const stickers = Array.isArray(stickerSet?.stickers) ? stickerSet.stickers : [];
    let added = 0;

    for (const sticker of stickers) {
      if (!sticker?.file_id) continue;
      const reactionType = getStickerReactionTypeByEmoji(sticker.emoji);
      if (saveFunSticker(sticker.file_id, reactionType)) {
        added++;
      }
    }

    data.importedStickerSets[setName] = {
      importedAt: new Date().toISOString(),
      total: stickers.length
    };
    scheduleFunReactionsWrite();
    console.log(`fun stickers imported: ${setName}, total=${stickers.length}, added=${added}`);

    return { setName, imported: true, added, total: stickers.length };
  } catch (error) {
    console.error('fun sticker set import error', setName, error.message);
    return { setName, imported: false, added: 0, total: 0, error: error.message };
  }
}

async function importConfiguredFunStickerSets(ctx) {
  if (!isFunStickerSetImportEnabled()) return;

  const setNames = getConfiguredFunStickerSetNames();
  for (const setName of setNames) {
    await importStickerSetForFunReactions(ctx, setName);
  }
}

function hasAnyFunReactionContent() {
  const envContent = [
    ...parseEnvList(process.env.FUN_ERROR_STICKERS),
    ...parseEnvList(process.env.FUN_SUCCESS_STICKERS),
    ...parseEnvList(process.env.FUN_ERROR_GIFS),
    ...parseEnvList(process.env.FUN_SUCCESS_GIFS)
  ];

  if (envContent.length > 0) return true;

  const stored = loadFunReactions();
  return (
    stored.successStickers.length > 0 ||
    stored.errorStickers.length > 0 ||
    stored.neutralStickers.length > 0 ||
    stored.successGifs.length > 0 ||
    stored.errorGifs.length > 0 ||
    stored.neutralGifs.length > 0
  );
}

function isFunReactionsEnabled() {
  const flag = String(process.env.FUN_REACTIONS_ENABLED || '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  return hasAnyFunReactionContent();
}

function getFunReactionTypeFromMessage(htmlText) {
  const plainText = String(htmlText || '')
    .replace(/<[^>]*>/g, '')
    .trim();

  if (plainText.startsWith('❌') || plainText.startsWith('⚠️')) return 'error';
  if (plainText.startsWith('✅')) return 'success';
  return null;
}

function getFunReactionCooldownMs() {
  const value = Number(process.env.FUN_REACTION_COOLDOWN_MS || 30000);
  return Number.isFinite(value) && value >= 0 ? value : 30000;
}

function canSendFunReaction(chatId) {
  const cooldown = getFunReactionCooldownMs();
  if (cooldown === 0) return true;

  const now = Date.now();
  const last = lastFunReactionAt.get(chatId) || 0;
  if (now - last < cooldown) return false;

  lastFunReactionAt.set(chatId, now);
  return true;
}

async function sendFunReaction(ctx, reactionType) {
  if (!isFunReactionsEnabled()) return;
  const chatId = ctx?.chat?.id;
  if (!chatId) return;
  if (!canSendFunReaction(chatId)) return;

  const envStickerList = reactionType === 'error'
    ? parseEnvList(process.env.FUN_ERROR_STICKERS)
    : parseEnvList(process.env.FUN_SUCCESS_STICKERS);
  const envGifList = reactionType === 'error'
    ? parseEnvList(process.env.FUN_ERROR_GIFS)
    : parseEnvList(process.env.FUN_SUCCESS_GIFS);

  const stored = loadFunReactions();
  const storedStickerList = reactionType === 'error'
    ? mergeUniqueItems(stored.errorStickers, stored.neutralStickers)
    : mergeUniqueItems(stored.successStickers, stored.neutralStickers);
  const storedGifList = reactionType === 'error'
    ? mergeUniqueItems(stored.errorGifs, stored.neutralGifs)
    : mergeUniqueItems(stored.successGifs, stored.neutralGifs);

  const stickerList = mergeUniqueItems(envStickerList, storedStickerList);
  const gifList = mergeUniqueItems(envGifList, storedGifList);

  const sticker = pickRandom(stickerList);
  const gif = pickRandom(gifList);

  try {
    if (sticker) {
      await ctx.replyWithSticker(sticker);
      return;
    }

    if (gif) {
      await ctx.replyWithAnimation(gif);
    }
  } catch (error) {
    console.error('fun reaction error', error.message);
  }
}

async function maybeSendFunReaction(ctx, htmlText) {
  const reactionType = getFunReactionTypeFromMessage(htmlText);
  if (!reactionType) return;
  await sendFunReaction(ctx, reactionType);
}

bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const originalReplyWithHTML = ctx.replyWithHTML.bind(ctx);
  ctx.replyWithHTML = async (htmlText, extra) => {
    const response = await originalReplyWithHTML(htmlText, extra);
    await maybeSendFunReaction(ctx, htmlText);
    return response;
  };

  await next();
});

bot.on('sticker', async (ctx) => {
  const sticker = ctx.message?.sticker;
  if (!sticker?.file_id) return;

  const reactionType = getStickerReactionTypeByEmoji(sticker.emoji);
  const saved = saveFunSticker(sticker.file_id, reactionType);

  if (saved) {
    console.log('fun sticker saved', reactionType, sticker.file_id);
  }

  if (sticker.set_name) {
    await importStickerSetForFunReactions(ctx, sticker.set_name);
  }
});

bot.on('animation', async (ctx) => {
  const animation = ctx.message?.animation;
  if (!animation?.file_id) return;

  const saved = saveFunGif(animation.file_id, 'neutral');
  if (saved) {
    console.log('fun gif saved', animation.file_id);
  }
});

function logMileagePhoto(telegramId, fileId, state) {
  appendLog(photoLogPath, {
    at: new Date().toISOString(),
    telegramId,
    fileId,
    fio: state?.fio || null,
    date: state?.date || null,
    stage: state?.stage || null,
    auto: state?.auto || null,
    workplace: state?.workplace || null
  });
}

function getNextRouteSheetNumber(state, date) {
  try {
    if (!fs.existsSync(routeSheetLogPath)) {
      return 1;
    }

    const lines = fs.readFileSync(routeSheetLogPath, 'utf8').split('\n').filter(Boolean);
    const count = lines.reduce((total, line) => {
      try {
        const entry = JSON.parse(line);
        return entry.date === date && entry.fio === state?.fio ? total + 1 : total;
      } catch (_) {
        return total;
      }
    }, 0);

    return count + 1;
  } catch (error) {
    console.error('route sheet count error', error);
    return 1;
  }
}

function logRouteSheetPhoto(telegramId, fileId, state, date, routeSheetNumber) {
  appendLog(routeSheetLogPath, {
    at: new Date().toISOString(),
    date,
    routeSheetNumber,
    telegramId,
    fileId,
    fio: state?.fio || null,
    carNumber: state?.carNumber || null,
    workplace: state?.workplace || null
  });
}

function logReconciliationPhoto(telegramId, fileId, state, label) {
  appendLog(reconciliationLogPath, {
    at: new Date().toISOString(),
    telegramId,
    fileId,
    fio: state?.fio || null,
    carNumber: state?.carNumber || null,
    workplace: state?.workplace || null,
    device: state?.device || null,
    label
  });
}

function parseMoneyRu(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\u00A0]/g, '').replace(/₽/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const number = Number(cleaned);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

function formatMoneyRu(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return null;
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
  return `${formatted} ₽`;
}

function formatMoneyRuNumber(value) {
  const withCurrency = formatMoneyRu(value);
  if (!withCurrency) return null;
  return withCurrency.replace(/\s*₽$/, '');
}

function extractOrdersCountFromOcrText(text) {
  const raw = String(text || '')
    .replace(/\u00A0/g, ' ')
    .trim();

  if (!raw) {
    return { totalOrders: null, reason: 'empty_text' };
  }

  const normalized = raw.replace(/\s+/g, ' ');

  const strictPatterns = [
    /заказо[кв]\s+за\s*(?:сегодня|сутки)\s*:?\s*(\d{1,5})/i,
    /за\s*(?:сегодня|сутки)\s*:?\s*(\d{1,5})/i,
  ];

  for (const pattern of strictPatterns) {
    const match = normalized.match(pattern);
    if (match && Number.isFinite(Number(match[1])) && Number(match[1]) > 0) {
      return { totalOrders: Number(match[1]), reason: 'ok' };
    }
  }

  const lines = raw.split(/\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/заказо[кв]/i.test(line)) {
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
        const candidate = lines[j].trim();
        const numMatch = candidate.match(/^(\d{1,5})$/);
        if (numMatch && Number.isFinite(Number(numMatch[1])) && Number(numMatch[1]) > 0) {
          return { totalOrders: Number(numMatch[1]), reason: 'ok' };
        }
      }
    }
  }

  const fallbackPatterns = [
    /заказо[кв]\s*:?\s*(\d{1,5})(?:\s|$)/i,
    /(\d{1,5})\s*заказо[кв]/i,
  ];

  for (const pattern of fallbackPatterns) {
    const match = normalized.match(pattern);
    if (match && Number.isFinite(Number(match[1])) && Number(match[1]) > 0) {
      return { totalOrders: Number(match[1]), reason: 'ok' };
    }
  }

  return { totalOrders: null, reason: 'no_orders_line' };
}

function extractCashFromOcrText(text) {
  const normalized = String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[|¦]/g, '/')
    .replace(/₽/g, ' ₽')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return { orders: null, amount: null, valid: false, reason: 'empty_text' };
  }

  const cashWordSource = 'налич[а-яa-z]*|[Hh]a[нn][лnM][иiч4][нn][ыb][еe]|[Hh]a[лn][иiч][нh][bл][еe]';
  const cashLineRegex = new RegExp(`(?:${cashWordSource})\\s*([0-9]{1,3})?\\s*/\\s*([0-9\\s.,]{1,20})?[P₽]?`, 'i');
  const cashMatch = normalized.match(cashLineRegex);

  if (cashMatch) {
    const ordersRaw = cashMatch[1] || '';
    const amountRaw = cashMatch[2] || '';
    const orders = Number(String(ordersRaw).replace(/\D/g, ''));
    const amount = parseMoneyRu(amountRaw);
    const hasOrders = Number.isFinite(orders) && orders > 0;
    const hasAmount = Number.isFinite(amount) && amount >= 1;

    return {
      orders: Number.isFinite(orders) ? orders : 0,
      amount: Number.isFinite(amount) ? amount : null,
      valid: hasOrders && hasAmount,
      reason: hasOrders && hasAmount ? 'ok' : 'insufficient'
    };
  }

  const amountPattern = /([0-9]{1,3})\s*\/\s*([0-9\s.,]{1,20})\s*[P₽]/i;
  const amountMatch = normalized.match(amountPattern);
  if (amountMatch) {
    const orders = Number(String(amountMatch[1] || '').replace(/\D/g, ''));
    const amount = parseMoneyRu(amountMatch[2]);
    const hasOrders = Number.isFinite(orders) && orders > 0;
    const hasAmount = Number.isFinite(amount) && amount >= 1;

    if (hasOrders && hasAmount) {
      return { orders, amount, valid: true, reason: 'ok' };
    }
  }

  const hasCashWord = new RegExp(`(?:${cashWordSource})`, 'i').test(normalized);
  if (hasCashWord) {
    return { orders: 0, amount: null, valid: false, reason: 'cash_line_empty' };
  }

  return { orders: null, amount: null, valid: false, reason: 'no_cash_line' };
}

function getReconciliationOcrTimeoutMs() {
  const value = Number(process.env.RECONCILIATION_OCR_TIMEOUT_MS || 30000);
  return Number.isFinite(value) && value >= 5000 ? value : 30000;
}



function emptyReconciliationCash(reason, source = 'none') {
  return { orders: null, amount: null, totalOrders: null, valid: false, reason, source };
}

async function recognizeReconciliationCashSafe(ctx, fileId, label) {
  try {
    return await withTimeout(
      recognizeReconciliationCash(ctx, fileId),
      getReconciliationOcrTimeoutMs(),
      `reconciliation OCR ${label || ''}`.trim()
    );
  } catch (error) {
    console.error('reconciliation OCR safe fallback', label || '', error.message || error);
    return emptyReconciliationCash('ocr_timeout', 'none');
  }
}

function shouldWarnAboutReconciliationOcr(cashInfo) {
  if (!cashInfo) return true;
  if (cashInfo.valid) return false;
  if (cashInfo.totalOrders && cashInfo.totalOrders > 0) return false;
  return ['ocr_timeout', 'error', 'local_ocr_error', 'local_ocr_timeout', 'no_ocr_result'].includes(cashInfo.reason);
}

async function recognizeReconciliationCashLocal() {
  return { orders: null, amount: null, totalOrders: null, valid: false, reason: 'local_ocr_disabled', source: 'none' };
}

async function recognizeReconciliationCash(ctx, fileId) {
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(link.href, { responseType: 'arraybuffer', timeout: 30000 });
    const imageBuffer = Buffer.from(response.data);

    let totalOrdersFromRapid = null;

    if (isRapidOcrEnabled()) {
      const rapidText = await recognizeTextWithRapidOcr(imageBuffer);
      if (rapidText) {
        const parsed = extractCashFromOcrText(rapidText);
        const ordersParsed = extractOrdersCountFromOcrText(rapidText);
        totalOrdersFromRapid = ordersParsed.totalOrders;
        console.log('сверка OCR:', JSON.stringify({ cashValid: parsed.valid, cashReason: parsed.reason, cashOrders: parsed.orders, cashAmount: parsed.amount, totalOrders: ordersParsed.totalOrders, ordersReason: ordersParsed.reason, source: 'rapidocr' }));

        if (parsed.valid) {
          return { ...parsed, totalOrders: ordersParsed.totalOrders, source: 'rapidocr' };
        }

        if (parsed.reason === 'cash_line_empty') {
          return { ...parsed, totalOrders: ordersParsed.totalOrders, source: 'rapidocr' };
        }
      } else {
        console.log('сверка OCR: RapidOCR вернул пустой текст');
      }
    }

    const localResult = await recognizeReconciliationCashLocal(imageBuffer);
    const totalOrders = totalOrdersFromRapid !== null ? totalOrdersFromRapid : (localResult.totalOrders || null);

    if (localResult.valid || localResult.reason === 'cash_line_empty' || localResult.reason === 'insufficient') {
      return { ...localResult, totalOrders };
    }

    return { ...localResult, totalOrders, reason: localResult.reason || 'local_only' };
  } catch (error) {
    console.error('reconciliation cash recognition error', error.message || error);
    return { orders: null, amount: null, totalOrders: null, valid: false, reason: 'error', source: 'none' };
  }
}

function makeMileageState(telegramId, baseState, extra = {}) {
  return {
    telegramId,
    ...baseState,
    awaitingMileagePhoto: true,
    awaitingManualMileage: false,
    photoReceived: false,
    ...extra
  };
}

function normalizeCarNumber(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function isValidCarNumber(value) {
  const normalized = normalizeCarNumber(value);
  if (!normalized) return false;
  if (normalized.length < 4 || normalized.length > 12) return false;
  return /[А-ЯЁA-Z]/.test(normalized) && /\d/.test(normalized);
}

function normalizeTimeValue(value) {
  const text = String(value || '').trim();

  // 1) Двоеточие — всегда время (пробелы вокруг ":" игнорируем)
  const noSpaces = text.replace(/\s+/g, '');
  const colonMatch = noSpaces.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colonMatch) {
    const minutes = Number(colonMatch[2]);
    if (minutes > 59) return null;
    return roundMinutesToHalfHour(Number(colonMatch[1]), minutes);
  }

  // 2) Точка / пробел + ДВЕ цифры → время (8.46, 8 14, 8.05, 07.30)
  const dotTimeMatch = text.match(/^(\d{1,2})[.\s]+(\d{2})$/);
  if (dotTimeMatch) {
    const minutes = Number(dotTimeMatch[2]);
    if (minutes > 59) return null;
    return roundMinutesToHalfHour(Number(dotTimeMatch[1]), minutes);
  }

  // 3) Точка / пробел + ОДНА цифра → десятичная дробь (8.5, 8 5, 7.3)
  const dotDecimalMatch = text.match(/^(\d{1,2})[.\s]+(\d)$/);
  if (dotDecimalMatch) {
    const minutes = Math.round(Number(dotDecimalMatch[2]) * 6); // 0.X * 60
    return roundMinutesToHalfHour(Number(dotDecimalMatch[1]), minutes);
  }

  // 4) Запятая или целое — десятичная дробь
  const decimalMatch = noSpaces.match(/^(\d{1,2})(?:,(\d{1,2}))?$/);
  if (decimalMatch) {
    const hours = Number(decimalMatch[1]);
    const fraction = decimalMatch[2] ? Number(`0.${decimalMatch[2]}`) : 0;
    const minutes = Math.round(fraction * 60);
    return roundMinutesToHalfHour(hours, minutes);
  }

  return null;
}

function isMenuText(text) {
  return [
    BUTTONS.punchTime,
    BUTTONS.mileage,
    BUTTONS.routeSheet,
    BUTTONS.reconciliation,
    BUTTONS.cashCheck,
    BUTTONS.issues,
    BUTTONS.leaderBoard,
    BUTTONS.settings,
    BUTTONS.help,
    BUTTONS.profile,
    BUTTONS.changeCar,
    BUTTONS.changeWorkplace,
    BUTTONS.changeDevice,
    BUTTONS.switchUser,
    BUTTONS.sheetInfo,
    BUTTONS.myId,
    'Время смены',
    'Внести время смены',
    'Время',
    'Внести пробег',
    'Пробег',
    'Маршрутный лист',
    'Маршрутник',
    'Сверки',
    'Деньги к сдаче',
    'Наличные',
    'Проблема с заказом',
    'Проблема',
    'Лидерборд',
    'Настройки',
    'Помощь',
    'Профиль',
    'Изменить номер машины',
    'Номер машины',
    'Поменять магазин',
    'Изменить интернет-магазин',
    'Магазин',
    'Изменить устройство',
    'Устройство',
    'Поменять сотрудника',
    'Сменить сотрудника',
    'Сотрудник',
    'Таблицы',
    'Мой ID',
    'Управление'
  ].includes(text) || WORKPLACES.includes(text) || DEVICES.includes(text);
}

async function askForCarNumber(ctx, fio = getUserField(ctx.from.id, 'fio')) {
  setState(ctx.from.id, { awaitingCarNumber: true, fio });
  await ctx.replyWithHTML(
    `🚗 <b>Номер машины</b>\n\nВведите гос. номер автомобиля.\nНапример: <code>А123ВС777</code>`,
    mainMenu()
  );
}

async function askForWorkplace(ctx, fio = getUserField(ctx.from.id, 'fio')) {
  setState(ctx.from.id, { awaitingWorkplace: true, fio });
  await ctx.replyWithHTML(
    '🏬 <b>Интернет-магазин</b>\n\nВыберите ваш магазин:',
    workplaceMenu()
  );
}

async function askForDevice(ctx, fio = getUserField(ctx.from.id, 'fio')) {
  setState(ctx.from.id, { awaitingDevice: true, fio });
  await ctx.replyWithHTML(
    '💻 <b>Рабочее устройство</b>\n\nВыберите устройство:',
    deviceMenu()
  );
}

async function saveCarNumber(ctx, value) {
  const carNumber = normalizeCarNumber(value);

  if (!carNumber || isMenuText(value)) {
    await ctx.replyWithHTML('❌ Введите номер машины текстом.\nНапример: <code>А123ВС777</code>');
    return;
  }

  if (!isValidCarNumber(carNumber)) {
    await ctx.replyWithHTML('❌ Неверный формат номера.\nНомер должен содержать буквы и цифры.\nНапример: <code>А123ВС777</code>');
    return;
  }

  setUserField(ctx.from.id, 'carNumber', carNumber);
  console.log('номер машины сохранён');

  if (!getUserField(ctx.from.id, 'workplace')) {
    await ctx.replyWithHTML(`✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`);
    await askForWorkplace(ctx);
    return;
  }

  if (!getUserField(ctx.from.id, 'device')) {
    await ctx.replyWithHTML(`✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`);
    await askForDevice(ctx);
    return;
  }

  clearState(ctx.from.id);
  await ctx.replyWithHTML(`✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`, mainMenu());
}

async function saveWorkplace(ctx, value) {
  const workplace = WORKPLACES.find((item) => item.toLowerCase() === String(value || '').trim().toLowerCase());

  if (!workplace) {
    await ctx.replyWithHTML('❌ Выберите магазин кнопкой ниже.', workplaceMenu());
    return;
  }

  setUserField(ctx.from.id, 'workplace', workplace);
  console.log('интернет-магазин сохранён');
  const role = getUserRole(ctx.from.id);

  if (role === 'logist') {
    clearState(ctx.from.id);
    await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`, logistMainMenu());
    return;
  }

  if (!getUserField(ctx.from.id, 'device')) {
    await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`);
    await askForDevice(ctx);
    return;
  }

  clearState(ctx.from.id);
  await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`, mainMenu());
}

async function saveDevice(ctx, value) {
  const device = DEVICES.find((item) => item.toLowerCase() === String(value || '').trim().toLowerCase());

  if (!device) {
    await ctx.replyWithHTML('❌ Выберите устройство кнопкой ниже.', deviceMenu());
    return;
  }

  setUserField(ctx.from.id, 'device', device);
  clearState(ctx.from.id);
  console.log('устройство сохранено');
  await ctx.replyWithHTML(`✅ Устройство сохранено: <b>${esc(device)}</b>`, mainMenu());
}

async function ensureProfile(ctx) {
  const profile = getFullProfile(ctx.from.id);
  const role = getUserRole(ctx.from.id);

  if (!profile.fio) {
    await askForFio(ctx);
    return null;
  }

  if (role !== 'logist') {
    if (!profile.carNumber) {
      await askForCarNumber(ctx, profile.fio);
      return null;
    }
  }

  if (!profile.workplace) {
    await askForWorkplace(ctx, profile.fio);
    return null;
  }

  if (role !== 'logist') {
    if (!profile.device) {
      await askForDevice(ctx, profile.fio);
      return null;
    }
  }

  return profile;
}

function applyCarNumber(result, carNumber) {
  return { ...result, auto: carNumber || result.auto };
}

function applyProfile(result, profile) {
  return { ...applyCarNumber(result, profile.carNumber), workplace: profile.workplace, device: profile.device };
}

async function askForFio(ctx) {
  const telegramId = ctx.from.id;
  setState(telegramId, { awaitingFio: true });
  await ctx.replyWithHTML(
    '👤 <b>Авторизация</b>\n\nВведите имя и фамилию как в таблице.',
    Markup.keyboard([[BUTTONS.back]]).resize()
  );
}

async function authorizeFio(ctx, fio) {
  const telegramId = ctx.from.id;

  try {
    console.log('авторизация ФИО');
    const employee = await findCourierInAllSheets(fio);

    if (!employee) {
      console.log('сотрудник не найден');
      await ctx.replyWithHTML('❌ Сотрудник не найден в таблице.\nПроверьте имя и фамилию и попробуйте ещё раз.');
      return;
    }

    setUserField(telegramId, 'fio', employee.fio);
    console.log('сотрудник найден');
    await ctx.replyWithHTML(`✅ Сотрудник найден: <b>${esc(employee.fio)}</b>`);

    setState(telegramId, { awaitingRoleChoice: true, fio: employee.fio });
    await ctx.replyWithHTML(
      '👤 <b>Выберите вашу роль:</b>\n\n' +
      '▫️ <b>Курьер</b> — доставка заказов, пробег, маршрутник, сверка, наличные\n' +
      '▫️ <b>Логист</b> — учёт времени, сбор наличных с курьеров, таблицы',
      roleChoiceKeyboard()
    );
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await ctx.replyWithHTML('⚠️ Ошибка Google Таблицы.\nПопробуйте ещё раз или обратитесь к администратору.');
  }
}

async function punchTimeFlow(ctx, explicitStage = null) {
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return;
  }

  try {
    const result = explicitStage
      ? await replaceTime(profile.fio, profile.workplace, explicitStage)
      : await punchTime(profile.fio, profile.workplace);

    if (result.notFound) {
      const msg = formatNoSheetMessage(result, profile.workplace);
      await ctx.replyWithHTML(msg);
      return;
    }

    if (result.needsReplaceChoice) {
      console.log('нужна замена');
      setState(telegramId, { awaitingReplaceChoice: true, fio: profile.fio });
      await ctx.replyWithHTML(
        `⚠️ За сегодня уже внесены начало и конец смены.\n\n` +
        `🟢 Старт: <code>${esc(result.from)}</code>\n` +
        `🔴 Конец: <code>${esc(result.to)}</code>\n\n` +
        `Выберите, что заменить:`,
        replaceKeyboard()
      );
      return;
    }

    console.log('время записано', result.stage);

    const icon = result.stage === 'start' ? '🟢' : '🔴';
    const label = result.stage === 'start' ? 'Старт' : 'Конец';

    setState(telegramId, {
      awaitingTimeChange: true,
      awaitingManualTime: false,
      fio: result.fio,
      courierRow: result.courierRow,
      day: result.day,
      stage: result.stage,
      timeValue: result.timeValue,
      workplace: profile.workplace
    });

    await ctx.replyWithHTML(
      `${icon} <b>${label} смены</b>: <code>${esc(result.timeValue)}</code>\n\n` +
      `<i>Если время неверное — нажмите «Изменить время».</i>`,
      timeChangeKeyboard()
    );

    if (result.stage === 'start') {
      const pendingCash = getUserField(telegramId, 'pendingCashToSubmit');
      const pendingAmount = Number(pendingCash?.amount || 0);

      if (Number.isFinite(pendingAmount) && pendingAmount >= 1) {
        const formattedAmount = pendingCash?.formatted || formatMoneyRu(pendingAmount);
        const numberOnly = formatMoneyRuNumber(pendingAmount) || String(formattedAmount || '').replace(/\s*₽$/, '');
        await ctx.replyWithHTML(
          `⚠️ <b>Не забудьте сдать деньги</b>: <code>${esc(numberOnly)}</code> ₽\n` +
          `🏬 <b>${esc(pendingCash?.workplace || profile.workplace || 'не указано')}</b>`,
          cashSubmitConfirmKeyboard()
        );
      }
    }
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await ctx.replyWithHTML('⚠️ Не удалось записать время.\nПопробуйте ещё раз или обратитесь к администратору.');
  }
}

async function mileageFlow(ctx, explicitStage = null) {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return;
  }

  try {
    const result = await prepareMileage(profile.fio, profile.workplace, explicitStage);

    if (result.notFound) {
      const msg = formatNoSheetMessage(result, profile.workplace);
      await ctx.replyWithHTML(msg);
      return;
    }

    if (result.needsReplaceChoice) {
      console.log('нужна замена пробега');
      setState(telegramId, { awaitingMileageReplaceChoice: true, fio: profile.fio });
      await ctx.replyWithHTML(
        `⚠️ За сегодня уже внесён пробег.\n\n` +
        `🟢 Старт: <code>${esc(result.startMileage)}</code>\n` +
        `🔴 Конец: <code>${esc(result.endMileage)}</code>\n\n` +
        `Выберите, что заменить:`,
        mileageReplaceKeyboard()
      );
      return;
    }

    setState(telegramId, makeMileageState(telegramId, applyProfile(result, profile), { source: 'mileage' }));
    console.log('ожидание пробега', result.stage);
    await ctx.replyWithHTML(
      `📷 <b>Отправьте фото одометра</b>\n\n` +
      `Этап: <b>${esc(formatStage(result.stage))}</b>\n\n` +
      `📎 <i>Нажмите на скрепку → Камера или Галерея</i>`,
      skipMileageKeyboard()
    );
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await ctx.replyWithHTML('⚠️ Не удалось подготовить запись пробега.\nПопробуйте ещё раз или обратитесь к администратору.');
  }
}

async function routeSheetFlow(ctx) {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return;
  }

  setState(telegramId, {
    awaitingRouteSheetPhoto: true,
    fio: profile.fio,
    carNumber: profile.carNumber,
    workplace: profile.workplace
  });

  await ctx.replyWithHTML(
    `📄 <b>Маршрутный лист</b>\n\n` +
    `Отправьте фото. Можно отправить несколько фото подряд.\n\n` +
    `📎 <i>Нажмите на скрепку → Камера или Галерея</i>`,
    routeSheetKeyboard()
  );
}

async function reconciliationFlow(ctx) {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return;
  }

  const isTerminal = profile.device === 'Терминал';
  const totalPhotos = isTerminal ? 2 : 1;

  setState(telegramId, {
    awaitingReconciliationPhoto: true,
    reconciliationPhotosSent: 0,
    reconciliationTotal: totalPhotos,
    fio: profile.fio,
    carNumber: profile.carNumber,
    workplace: profile.workplace,
    device: profile.device
  });

  const firstLabel = isTerminal ? '📊 Статистика' : 'Пин-Панель';
  const orderHint = isTerminal
    ? '<b>Порядок:</b> сначала скриншот статистики, потом чек.'
    : '';

  const lines = [
    `📸 <b>Сверки</b>`,
    '',
    `📷 Фото <b>1 из ${totalPhotos}</b>: <b>${firstLabel}</b>`,
  ];
  if (orderHint) {
    lines.push('');
    lines.push(orderHint);
  }
  lines.push('');
  lines.push('📎 <i>Нажмите на скрепку → Камера или Галерея</i>');

  await ctx.replyWithHTML(lines.join('\n'), routeSheetKeyboard());
}

async function showPendingCashStatus(ctx) {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const profile = await ensureProfile(ctx);
  if (!profile) return;

  const pendingCash = getUserField(ctx.from.id, 'pendingCashToSubmit');
  const amount = Number(pendingCash?.amount || 0);

  if (!Number.isFinite(amount) || amount < 1) {
    await ctx.replyWithHTML('✅ Долгов нет — все деньги сданы.', getMenuForRole(ctx.from.id));
    return;
  }

  if (pendingCash?.confirmationStatus === 'awaiting') {
    await ctx.replyWithHTML('⏳ Вы уже отметили сдачу. Ожидайте подтверждения логиста.', getMenuForRole(ctx.from.id));
    return;
  }

  const formatted = pendingCash?.formatted || formatMoneyRu(amount);
  const numberOnly = formatMoneyRuNumber(amount) || String(formatted || '').replace(/\s*₽$/, '');
  const workplace = pendingCash?.workplace || profile.workplace || 'не указано';
  const fun = String(process.env.FUN_TONE || '').toLowerCase() === 'true';
  const lines = [
    `💵 <b>Деньги к сдаче</b>: <code>${esc(numberOnly)}</code> ₽`,
    `🏬 <b>${esc(workplace)}</b>`,
    ''
  ];
  if (fun) lines.push('😼 Ай-ай, денюжки надо сдать!', '');
  lines.push('Сдали деньги в кассу?');
  await ctx.replyWithHTML(lines.join('\n'), cashSubmitConfirmKeyboard());
}

async function sendHelp(ctx) {
  const role = getUserRole(ctx.from.id);

  if (role === 'logist') {
    await ctx.replyWithHTML(
      '❓ <b>Помощь</b>\n' +
      '━━━━━━━━━━━━━━━\n\n' +
      `1️⃣ <b>Записать время</b> — «${BUTTONS.punchTime}» отметить начало или конец смены.\n` +
      `2️⃣ <b>Принять наличные</b> — «${BUTTONS.cashCollect}» посмотреть должников и отправить напоминание.\n` +
      `3️⃣ <b>Таблицы</b> — «${BUTTONS.sheetInfo}» информация о привязке таблиц.\n` +
      `4️⃣ <b>Настройки</b> — «${BUTTONS.settings}» магазин, смена сотрудника.\n\n` +
      '📋 Команды:',
      Markup.inlineKeyboard([
        [Markup.button.callback('📋 Команды', 'help_commands')]
      ])
    );
    return;
  }

  await ctx.replyWithHTML(
    '❓ <b>Помощь</b>\n' +
    '━━━━━━━━━━━━━━━\n\n' +
    '1️⃣ <b>Первый вход</b> — введите ФИО, номер машины, магазин и устройство.\n' +
    `2️⃣ <b>Записать время</b> — «${BUTTONS.punchTime}» отметить начало или конец смены.\n` +
    `3️⃣ <b>Фото пробега</b> — «${BUTTONS.mileage}» отправьте фото одометра или введите вручную.\n` +
    '   • «📷 Загрузить фото повторно» или «✏️ Ввести вручную» если не распозналось.\n' +
    `4️⃣ <b>Отправить маршрутник</b> — «${BUTTONS.routeSheet}» отправить фото маршрутного листа.\n` +
    `5️⃣ <b>Отправить сверку</b> — «${BUTTONS.reconciliation}» Терминал — 2 фото, Пин-Панель — 1 фото.\n` +
    `6️⃣ <b>Сдать наличные</b> — «${BUTTONS.cashCheck}» показать сумму к сдаче и подтвердить.\n` +
    `7️⃣ <b>Проблема с заказом</b> — «${BUTTONS.issues}» ссылки для решения проблем с заказами.\n` +
    `8️⃣ <b>Рейтинг</b> — «${BUTTONS.leaderBoard}» рейтинг курьеров по заказам.\n` +
    `9️⃣ <b>Настройки</b> — «${BUTTONS.settings}» номер машины, магазин, устройство, сотрудник.\n\n` +
    '📋 Команды:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📋 Команды', 'help_commands')]
    ])
  );
}

async function sendCommandsList(ctx) {
  const isAdmin = isAdminUser(ctx.from.id);
  const role = getUserRole(ctx.from.id);
  let msg = '📋 <b>Команды</b>\n' +
    '━━━━━━━━━━━━━━━\n\n' +
    '<b>Основные:</b>\n' +
    '/help — помощь\n' +
    '/cancel — отмена текущего действия\n\n';

  if (role !== 'logist') {
    msg += '<b>Настройки:</b>\n' +
      '/car — сменить номер машины\n' +
      '/workplace — сменить магазин\n' +
      '/device — сменить устройство\n\n';
  } else {
    msg += '<b>Настройки:</b>\n' +
      '/workplace — сменить магазин\n\n';
  }

  if (isAdmin) {
    msg += '<b>Администратору:</b>\n' +
      '/chatid — информация о чате\n' +
      '/sheet — привязка таблиц\n' +
      '/sheet_access — доступ к «📋 Таблицы»\n' +
      '  <code>/sheet_access</code> — показать список\n' +
      '  <code>/sheet_access 123456789</code> — дать доступ\n' +
      '  <code>/sheet_access - 123456789</code> — убрать доступ\n' +
      '/role — сменить роль пользователя\n\n';
  }

  if (role === 'logist') {
    msg += '<b>Кнопки меню:</b>\n' +
      `⏱ <b>Время</b> — записать старт/конец\n` +
      `💳 <b>Наличные</b> — посмотреть должников, отправить напоминание\n` +
      `📋 <b>Таблицы</b> — информация о привязке таблиц\n` +
      `⚙️ <b>Настройки</b> — магазин, сотрудник`;
  } else {
    msg += '<b>Кнопки меню:</b>\n' +
      `⏱ <b>Время</b> — записать старт/конец\n` +
      `🚗 <b>Пробег</b> — фото одометра → распознавание\n` +
      `📄 <b>Маршрутник</b> — отправить фото\n` +
      `📊 <b>Сверки</b> — фото терминала/пин-панели\n` +
      `💵 <b>Наличные</b> — сумма к сдаче\n` +
      `⚠️ <b>Проблема</b> — решить проблему с заказом\n` +
      `🏆 <b>Лидерборд</b> — рейтинг курьеров\n` +
      `⚙️ <b>Настройки</b> — машина, магазин, устройство, сотрудник`;
  }

  await ctx.replyWithHTML(msg);
}

function parseUpdateNotesFromEnv() {
  const raw = String(process.env.UPDATE_NOTES || '').trim();
  if (!raw) return [];

  return raw
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function loadChangelog() {
  try {
    if (!fs.existsSync(changelogPath)) return null;
    return JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
  } catch {
    return null;
  }
}

function getLatestChangelogNotes() {
  const changelog = loadChangelog();
  if (!changelog || !Array.isArray(changelog.updates) || changelog.updates.length === 0) return null;

  const latest = changelog.updates[changelog.updates.length - 1];
  if (!latest || !Array.isArray(latest.notes) || latest.notes.length === 0) return null;

  return latest.notes.slice(0, 4);
}

function getChangelogBump() {
  const changelog = loadChangelog();
  if (!changelog || !Array.isArray(changelog.updates) || changelog.updates.length === 0) return 'patch';

  const latest = changelog.updates[changelog.updates.length - 1];
  const bump = String(latest.bump || '').toLowerCase().trim();
  if (bump === 'major' || bump === 'minor') return bump;
  return 'patch';
}

function consumeChangelogEntry() {
  const changelog = loadChangelog();
  if (!changelog || !Array.isArray(changelog.updates) || changelog.updates.length === 0) return;
  changelog.updates.pop();
  try {
    const tmp = changelogPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(changelog, null, 2), 'utf8');
    fs.renameSync(tmp, changelogPath);
  } catch (err) {
    console.error('changelog consume error', err.message);
  }
}

function buildUpdateHighlights(changedFiles = [], version) {
  const changelogNotes = getLatestChangelogNotes();
  if (changelogNotes && changelogNotes.length > 0) {
    return changelogNotes;
  }

  const envNotes = parseUpdateNotesFromEnv();
  if (envNotes.length > 0) {
    return envNotes;
  }

  const files = new Set((changedFiles || []).map((file) => String(file || '').toLowerCase()));
  const includesAny = (targets) => targets.some((target) => files.has(target.toLowerCase()));
  const highlights = [];

  if (includesAny(['bot.js'])) {
    highlights.push('🤖 Подправили сценарии работы и стабильность.');
  }

  if (includesAny(['sheetcommand.js', 'googlesheets.js', 'storage.js'])) {
    highlights.push('🗂 Улучшили работу с таблицами и привязками.');
  }

  if (includesAny(['mileageocr.js'])) {
    highlights.push('📸 Улучшили распознавание пробега по фото.');
  }

  if (includesAny(['utils.js'])) {
    highlights.push('🧮 Обновили вспомогательные функции.');
  }

  if (highlights.length === 0) {
    highlights.push('✨ Небольшие улучшения стабильности и удобства.');
  }

  return highlights.slice(0, 4);
}

function formatUpdateMessage(version, changedFiles = []) {
  const highlights = buildUpdateHighlights(changedFiles);
  const lines = highlights.map((item) => `• ${esc(item)}`).join('\n');

  return (
    `🆕 <b><i>Обновление бота v${esc(version)}</i></b>\n\n` +
    '<b>Коротко, что изменили:</b>\n' +
    `${lines}\n\n` +
    '💙 Хорошей смены!'
  );
}

async function notifyUsersAboutUpdate(version, changedFiles = []) {
  const currentVersion = version || getVersion();
  const userIds = getAllUserIds();
  let notified = 0;
  let skipped = 0;
  let failed = 0;

  const message = formatUpdateMessage(currentVersion, changedFiles);

  for (const telegramId of userIds) {
    const lastVersion = getUserField(telegramId, 'version');
    if (lastVersion === currentVersion) {
      skipped++;
      continue;
    }

    try {
      await withTimeout(
        bot.telegram.sendMessage(Number(telegramId), message, {
          parse_mode: 'HTML',
          disable_notification: true
        }),
        10000,
        'update notify'
      );
      setUserField(telegramId, 'version', currentVersion);
      notified++;
    } catch (error) {
      console.error('update notify error', error.message);
      failed++;
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`update v${currentVersion} notify summary: total=${userIds.length}, sent=${notified}, skipped=${skipped}, failed=${failed}`);
}

const _pendingUpdates = {};

async function askAdminsAboutUpdate(version, changedFiles = []) {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    console.log('no admin IDs configured, skipping update approval');
    return;
  }

  const message = formatUpdateMessage(version, changedFiles);
  const previewText = (
    `🔔 <b>Обнаружено обновление v${esc(version)}</b>\n\n` +
    '<b>Предпросмотр сообщения:</b>\n\n' +
    `${message}\n\n` +
    'Отправить уведомление всем пользователям?'
  );

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Отправить', `upd_send:${version}`),
      Markup.button.callback('✏️ Изменить текст', `upd_edit:${version}`)
    ],
    [Markup.button.callback('⏭️ Пропустить', `upd_skip:${version}`)]
  ]);

  _pendingUpdates[version] = { changedFiles, message };

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, previewText, {
        parse_mode: 'HTML',
        ...keyboard
      });
    } catch (error) {
      console.error('admin update ask error', adminId, error.message);
    }
  }
}

bot.action(/^upd_send:(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) {
    await ctx.answerCbQuery();
    return;
  }
  const version = ctx.match[1];
  const pending = _pendingUpdates[version];
  if (!pending) {
    await ctx.answerCbQuery('⚠️ Обновление уже обработано');
    return;
  }
  delete _pendingUpdates[version];
  await ctx.editMessageText('✅ Уведомление отправляется...', { parse_mode: 'HTML' });
  await notifyUsersAboutUpdate(version, pending.changedFiles);
  consumeChangelogEntry();
  try {
    await ctx.editMessageText(`✅ Уведомление v${esc(version)} отправлено всем пользователям.`, { parse_mode: 'HTML' });
  } catch {}
});

bot.action(/^upd_edit:(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) {
    await ctx.answerCbQuery();
    return;
  }
  const version = ctx.match[1];
  const pending = _pendingUpdates[version];
  if (!pending) {
    await ctx.answerCbQuery('⚠️ Обновление уже обработано');
    return;
  }
  setState(ctx.from.id, { awaitingUpdateEdit: true, editVersion: version });
  await ctx.replyWithHTML('✏️ <b>Редактирование уведомления</b>\n\nОтправьте новый текст сообщения (без заголовка «Обновление бота v...» и «Хорошей смены» — они добавятся автоматически):');
  await ctx.answerCbQuery();
});

bot.action(/^upd_skip:(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) {
    await ctx.answerCbQuery();
    return;
  }
  const version = ctx.match[1];
  delete _pendingUpdates[version];
  try {
    await ctx.editMessageText(`⏭️ Уведомление v${esc(version)} пропущено.`, { parse_mode: 'HTML' });
  } catch {}
  await ctx.answerCbQuery('Пропущено');
});

async function saveMileageFromState(ctx, mileage) {
  const telegramId = ctx.from.id;
  const state = getState(telegramId);
  const mileageValue = parseMileageNumber(mileage);

  if (!state || !state.mileageRow || !state.day || !state.stage) {
    await ctx.replyWithHTML('⚠️ Не удалось записать пробег.\nПопробуйте ещё раз или обратитесь к администратору.');
    return;
  }

  if (!mileageValue) {
    await ctx.replyWithHTML('❌ Неверный пробег. Допустимы только 2-6 цифр.\nНапример: <code>25408</code>');
    return;
  }

  try {
    if (state.stage === 'end') {
      const startCell = getMileageStageCell(state, 'start');

      if (startCell) {
        const sheetContext = resolveSheetInfo(startCell.workplace);
        if (!sheetContext.sheetId) {
          await ctx.replyWithHTML(formatNoSheetMessage({
            noSheet: true,
            noSheetForMonth: sheetContext.noSheetForMonth,
            monthKey: sheetContext.monthKey
          }, startCell.workplace));
          return;
        }

        const startRaw = await readCell(startCell.sheetName, startCell.cell, sheetContext.sheetId);
        const startValue = parseMileageNumber(startRaw);
        const maxDelta = getMaxShiftMileageDelta();

        if (startValue && mileageValue < startValue) {
          await ctx.replyWithHTML(
            `❌ Пробег конца смены не может быть меньше старта.\n` +
            `Старт: <code>${startValue}</code> км\n` +
            `Введено: <code>${mileageValue}</code> км`
          );
          return;
        }

        if (startValue && (mileageValue - startValue) > maxDelta) {
          await ctx.replyWithHTML(
            `❌ Слишком большой прирост пробега за смену.\n` +
            `Старт: <code>${startValue}</code> км\n` +
            `Введено: <code>${mileageValue}</code> км\n` +
            `Максимум за смену: <code>${maxDelta}</code> км`
          );
          return;
        }
      }
    }

    await updateMileage(state.mileageRow, state.day, state.stage, mileageValue, state.workplace);
    console.log('пробег записан');
    logOcrFeedback(telegramId, state.ocrValue || null, mileageValue);
    setState(telegramId, {
      ...state,
      awaitingMileagePhoto: false,
      awaitingManualMileage: false,
      photoReceived: true,
      savedMileage: mileageValue
    });
    await ctx.replyWithHTML(
      `✅ <b>Пробег сохранён</b>: <code>${mileageValue}</code> км\n\nЕсли неверно — нажмите «Изменить пробег».`,
      mileageSavedKeyboard()
    );
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await ctx.replyWithHTML('⚠️ Не удалось записать пробег.\nПопробуйте ещё раз или обратитесь к администратору.');
  }
}

async function sendPhotoToChat(ctx, fileId, caption, { envChatId, envThreadId, parseMode, fallbackChatId } = {}) {
  let chatId = envChatId ? process.env[envChatId] : null;

  if (!chatId && fallbackChatId) {
    chatId = fallbackChatId;
  }

  if (!chatId) {
    console.log(`${envChatId || 'chatId'} is empty, photo is not forwarded`);
    return false;
  }

  const options = { caption };

  if (parseMode) {
    options.parse_mode = parseMode;
  }

  const threadId = envThreadId ? process.env[envThreadId] : null;
  if (threadId) {
    options.message_thread_id = Number(threadId);
  }

  try {
    await ctx.telegram.sendPhoto(chatId, fileId, options);
    return true;
  } catch (error) {
    console.error('telegram sendPhoto error', error?.message || error);
    return false;
  }
}

async function sendMediaGroupToChat(ctx, items, { envChatId, envThreadId, parseMode, fallbackChatId } = {}) {
  let chatId = envChatId ? process.env[envChatId] : null;

  if (!chatId && fallbackChatId) {
    chatId = fallbackChatId;
  }

  if (!chatId) {
    console.log(`${envChatId || 'chatId'} is empty, media group is not forwarded`);
    return false;
  }

  const media = items.map((item, index) => {
    const entry = {
      type: 'photo',
      media: item.fileId
    };
    if (index === 0 && item.caption) {
      entry.caption = item.caption;
      if (parseMode) {
        entry.parse_mode = parseMode;
      }
    }
    return entry;
  });

  const options = {};
  const threadId = envThreadId ? process.env[envThreadId] : null;
  if (threadId) {
    options.message_thread_id = Number(threadId);
  }

  try {
    await ctx.telegram.sendMediaGroup(chatId, media, options);
    return true;
  } catch (error) {
    console.error('telegram sendMediaGroup error', error?.message || error);
    return false;
  }
}

// Конфиг назначений фото — единая таблица. Если появится новый чат
// (например, для штрафов), добавить запись и одну функцию-обёртку.
const PHOTO_DESTINATIONS = {
  work: {
    envChatId: 'WORK_CHAT_ID',
    envThreadId: 'WORK_THREAD_ID'
  },
  routeSheet: {
    envChatId: 'ROUTE_SHEET_CHAT_ID',
    envThreadId: 'ROUTE_SHEET_THREAD_ID',
    fallbackEnvChatId: 'WORK_CHAT_ID'
  },
  reconciliation: {
    envChatId: 'RECONCILIATION_CHAT_ID',
    envThreadId: 'RECONCILIATION_THREAD_ID',
    fallbackEnvChatId: 'WORK_CHAT_ID',
    parseMode: 'HTML'
  }
};

function forwardPhoto(ctx, fileId, caption, destinationKey) {
  const dest = PHOTO_DESTINATIONS[destinationKey];
  if (!dest) {
    console.error('forwardPhoto: unknown destination', destinationKey);
    return Promise.resolve(false);
  }
  return sendPhotoToChat(ctx, fileId, caption, {
    envChatId: dest.envChatId,
    envThreadId: dest.envThreadId,
    parseMode: dest.parseMode,
    fallbackChatId: dest.fallbackEnvChatId ? process.env[dest.fallbackEnvChatId] : undefined
  });
}

// Обёртки оставлены для читаемости в местах вызова.
const sendPhotoToWorkChat = (ctx, fileId, caption) => forwardPhoto(ctx, fileId, caption, 'work');
const sendPhotoToRouteSheetChat = (ctx, fileId, caption) => forwardPhoto(ctx, fileId, caption, 'routeSheet');
const sendPhotoToReconciliationChat = (ctx, fileId, caption) => forwardPhoto(ctx, fileId, caption, 'reconciliation');

function forwardMediaGroup(ctx, items, destinationKey) {
  const dest = PHOTO_DESTINATIONS[destinationKey];
  if (!dest) {
    console.error('forwardMediaGroup: unknown destination', destinationKey);
    return Promise.resolve(false);
  }
  return sendMediaGroupToChat(ctx, items, {
    envChatId: dest.envChatId,
    envThreadId: dest.envThreadId,
    parseMode: dest.parseMode,
    fallbackChatId: dest.fallbackEnvChatId ? process.env[dest.fallbackEnvChatId] : undefined
  });
}

const sendMediaGroupToReconciliationChat = (ctx, items) => forwardMediaGroup(ctx, items, 'reconciliation');

async function backToMainMenu(ctx) {
  const state = getState(ctx.from.id);
  clearState(ctx.from.id);

  const message = state?.savedMileage
    ? '⬅️ Возвращаю в меню.'
    : state?.mileageRow
      ? '⬅️ Возвращаю в меню. Пробег не сохранён.'
      : '⬅️ Возвращаю в меню.';

  await ctx.replyWithHTML(message, getMenuForRole(ctx.from.id));
}

async function showLeaderboardMenu(ctx) {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  await ctx.replyWithHTML(
    '🏆 <b>Лидерборд</b>\n\nВыберите магазин:',
    Markup.inlineKeyboard([
      [Markup.button.callback('🏬 ИМ Восток', 'lb_wp_east')],
      [Markup.button.callback('🏬 ИМ Центр', 'lb_wp_center')],
      [Markup.button.callback('🌐 Общий', 'lb_wp_all')],
      [Markup.button.callback('🏠 В меню', 'back_to_menu')]
    ])
  );
}

async function showLeaderboardTypeMenu(ctx, workplace) {
  const wpLabels = { east: 'ИМ Восток', center: 'ИМ Центр', all: 'Общий' };
  const wpLabel = wpLabels[workplace] || workplace;
  await ctx.replyWithHTML(
    `🏆 <b>Лидерборд — ${esc(wpLabel)}</b>\n\nВыберите тип рейтинга:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🏅 Топ за день', `lb_day_${workplace}`)],
      [Markup.button.callback('🌟 Топ за всё время', `lb_total_${workplace}`)],
      [Markup.button.callback('⬅️ Назад', 'lb_back')]
    ])
  );
}

async function showLeaderboardPeriods(ctx, workplace) {
  await ctx.replyWithHTML(
    '🏅 <b>Топ за день</b> — максимальное кол-во заказов за один день\n\nВыберите период:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('7 дней', `lb_p_7_${workplace}`),
        Markup.button.callback('30 дней', `lb_p_30_${workplace}`)
      ],
      [
        Markup.button.callback('365 дней', `lb_p_365_${workplace}`),
        Markup.button.callback('Всё время', `lb_p_0_${workplace}`)
      ],
      [Markup.button.callback('⬅️ Назад', `lb_wp_${workplace}`)]
    ])
  );
}

async function showLeaderboardResult(ctx, type, periodDays, workplace) {
  const telegramId = ctx.from.id;
  const showWorkplace = workplace === 'all';
  const entries = calculateLeaderboard(type, periodDays, workplace);

  const wpLabels = { east: 'ИМ Восток', center: 'ИМ Центр', all: 'Общий' };
  const wpLabel = wpLabels[workplace] || workplace;

  if (entries.length === 0) {
    await ctx.replyWithHTML(
      `🏆 <b>Лидерборд пуст</b>\n\nПока нет данных. Отправьте сверку, чтобы появиться в рейтинге!`,
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Назад', type === 'max' ? `lb_day_${workplace}` : `lb_wp_${workplace}`)]
      ])
    );
    return;
  }

  const periodLabels = {
    7: '7 дней',
    30: '30 дней',
    365: '365 дней',
    0: 'Всё время'
  };

  const typeLabel = type === 'max' ? '🏅 Топ за день' : '🌟 Топ за всё время';
  const periodLabel = type === 'max' ? ` (${periodLabels[periodDays] || periodDays + ' дней'})` : '';

  const text = formatLeaderboard(entries, telegramId, showWorkplace);
  const header = `${typeLabel} — ${esc(wpLabel)}${periodLabel}\n━━━━━━━━━━━━━━━\n`;

  await ctx.replyWithHTML(
    header + text,
    Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Назад', type === 'max' ? `lb_day_${workplace}` : `lb_wp_${workplace}`)]
    ])
  );
}

async function handleLeaderboardNotifications(ctx, telegramId, fio, workplace, ordersCount) {
  try {
    const notifications = checkLeaderboardNotifications(telegramId, fio, workplace, ordersCount);
    for (const notif of notifications) {
      if (notif.type === 'personal_record') {
        await ctx.replyWithHTML(
          `🎉 <b>Новый личный рекорд!</b>\n\nВы доставили <b>${notif.value}</b> заказов за день!\nПредыдущий рекорд: ${notif.previous} заказов.`
        );
      }
    }
  } catch (err) {
    console.error('leaderboard notification error', err.message || err);
  }
}

async function showIssuesMenu(ctx) {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const deliveryUrl = process.env.ISSUE_DELIVERY_URL;
  const flowwowUrl = process.env.ISSUE_FLOWWOW_URL;
  const techsupportUrl = process.env.ISSUE_TECHSUPPORT_URL;

  const buttons = [];

  if (deliveryUrl) {
    buttons.push([Markup.button.url('📦 Доставка — проблемы с нашими заказами', deliveryUrl)]);
  }
  if (flowwowUrl) {
    buttons.push([Markup.button.url('🌸 Flowwow — заказы Flowwow', flowwowUrl)]);
  }
  if (techsupportUrl) {
    buttons.push([Markup.button.url('🔧 Техподдержка — технические проблемы', techsupportUrl)]);
  }

  if (buttons.length === 0) {
    await ctx.replyWithHTML('⚠️ Раздел «Проблема с заказом» временно недоступен.', mainMenu());
    return;
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'issues_back')]);

  await ctx.replyWithHTML(
    '⚠️ <b>Проблема с заказом</b>\n\nВыберите чат для обращения:',
    Markup.inlineKeyboard(buttons)
  );
}

bot.start(async (ctx) => {
  console.log('/start');

  if (!getUserField(ctx.from.id, 'fio')) {
    setUserField(ctx.from.id, 'version', getVersion());
    const isNew = markUserSeen(ctx.from.id);
    if (isNew) {
      const firstName = ctx.from.first_name || '';
      const lastName = ctx.from.last_name || '';
      const username = ctx.from.username ? `@${ctx.from.username}` : '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';
      const adminIds = getAdminIds();
      for (const adminId of adminIds) {
        try {
          await ctx.telegram.sendMessage(adminId,
            `🆕 <b>Новый пользователь</b>\n\n` +
            `👤 ${esc(displayName)} ${esc(username)}\n` +
            `🆔 <code>${ctx.from.id}</code>`,
            { parse_mode: 'HTML' }
          );
        } catch (e) { /* ignore */ }
      }
    }
    await ctx.replyWithHTML('👋 <b>Привет!</b>\n\nЭто бот для учёта смены, времени и пробега автомобиля.');
    await askForFio(ctx);
    return;
  }

  setUserField(ctx.from.id, 'version', getVersion());

  const profile = await ensureProfile(ctx);

  if (!profile) {
    return;
  }

  const role = getUserRole(ctx.from.id);

  if (role === 'logist') {
    await ctx.replyWithHTML(
      `👋 Привет, <b>${esc(getEmployeeDisplayName(profile.fio))}</b>!\n\n` +
      `⏱ <b>Записать время</b> — отметить начало или конец смены.\n` +
      `💳 <b>Принять наличные</b> — посмотреть курьеров с долгами и отправить напоминание.\n` +
      `📋 <b>Таблицы</b> — информация о привязке таблиц.\n` +
      `⚙️ <b>Настройки</b> — профиль, магазин, смена сотрудника.`,
      logistMainMenu()
    );
  } else {
    await ctx.replyWithHTML(
      `👋 Привет, <b>${esc(getEmployeeDisplayName(profile.fio))}</b>!\n\n` +
      `⏱ <b>Записать время</b> — отметить начало или конец смены, автоматически выбирается время старта и вносится в таблицу ботом.\n` +
      `🚗 <b>Фото пробега</b> — отправить фото одометра и бот автоматически скинет фото в нужный чат и запишет пробег в таблицу.\n` +
      `📄 <b>Отправить маршрутник</b> — прикрепить маршрутный лист, бот отправит фото в нужный чат.\n` +
      `📊 <b>Отправить сверку</b> — отправить фото сверки, бот отправит фото в нужный чат.\n` +
      `💵 <b>Сдать наличные</b> — отметить сдачу наличных, также укажет сумму нужную сдать и подтверждение сдал/не сдал.\n` +
      `⚠️ <b>Проблема с заказом</b> — сообщить о проблеме, бот предлагает варианты ссылками на нужный чат/бота поддержки.\n` +
      `🏆 <b>Рейтинг</b> — посмотреть рейтинг курьеров.\n` +
      `⚙️ <b>Настройки</b> — профиль, машина, магазин, также смена сотрудника и тд.`,
      mainMenu()
    );
  }
});

bot.help(sendHelp);

bot.command('car', async (ctx) => {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта команда доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const fio = getUserField(ctx.from.id, 'fio');
  if (!fio) { await askForFio(ctx); return; }
  await askForCarNumber(ctx, fio);
});

bot.command('workplace', async (ctx) => {
  const fio = getUserField(ctx.from.id, 'fio');
  if (!fio) { await askForFio(ctx); return; }
  await askForWorkplace(ctx, fio);
});

bot.command('device', async (ctx) => {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта команда доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const fio = getUserField(ctx.from.id, 'fio');
  if (!fio) { await askForFio(ctx); return; }
  await askForDevice(ctx, fio);
});

// Парсим ADMIN_IDS из .env. Кэшируем результат в _adminIdsCache, чтобы
// не разбирать строку на каждом сообщении (раньше это происходило в
// 5+ местах кода).
let _adminIdsCache = null;
let _adminIdsRaw = null;

function getAdminIds() {
  const raw = String(process.env.ADMIN_IDS || '');
  if (raw === _adminIdsRaw && _adminIdsCache) return _adminIdsCache;
  _adminIdsRaw = raw;
  _adminIdsCache = raw.split(',').map((id) => Number(id.trim())).filter(Number.isFinite);
  return _adminIdsCache;
}

function isAdminUser(telegramId) {
  const adminIds = getAdminIds();
  return adminIds.length > 0 && adminIds.includes(Number(telegramId));
}

async function notifyAdmins(html, options = {}) {
  // Уведомить всех админов. Заблокированный админ пропускается без шума.
  for (const adminId of getAdminIds()) {
    try {
      await bot.telegram.sendMessage(adminId, html, { parse_mode: 'HTML', ...options });
    } catch (e) {
      console.error('admin notify failed', adminId, e.message);
    }
  }
}

bot.command('chatid', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) {
    return;
  }
  await ctx.replyWithHTML(
    `📍 <b>Chat info</b>\n\nchat_id: <code>${ctx.chat.id}</code>\nmessage_thread_id: <code>${ctx.message.message_thread_id || 'нет'}</code>`
  );
});

bot.command('sheet_access', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) {
    return;
  }

  const args = (ctx.message.text || '').replace(/^\/sheet_access\s*/, '').trim().split(/\s+/);

  if (args.length === 1 && args[0] === '') {
    const users = getSheetAccessUsers();
    const adminIds = getAdminIds();
    let msg = '📋 <b>Доступ к Таблицам</b>\n\n';
    msg += '🔑 <b>Администраторы:</b>\n';
    for (const id of adminIds) {
      msg += `   • <code>${id}</code>\n`;
    }
    msg += '\n👥 <b>Допущенные пользователи:</b>\n';
    if (users.length === 0) {
      msg += '   (пусто)\n';
    } else {
      for (const id of users) {
        msg += `   • <code>${id}</code>\n`;
      }
    }
    msg += '\n<b>Команды:</b>\n';
    msg += '<code>/sheet_access 123456789</code> — дать доступ\n';
    msg += '<code>/sheet_access - 123456789</code> — убрать доступ';
    await ctx.replyWithHTML(msg);
    return;
  }

  if (args[0] === '-' || args[0] === 'del' || args[0] === 'remove') {
    const targetId = Number(args[1]);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      await ctx.replyWithHTML('❌ Неверный Telegram ID.');
      return;
    }
    const removed = removeSheetAccessUser(targetId);
    if (removed) {
      await ctx.replyWithHTML(`✅ Доступ к Таблицам убран для <code>${targetId}</code>`);
    } else {
      await ctx.replyWithHTML(`ℹ️ Пользователь <code>${targetId}</code> не имел доступа.`);
    }
    return;
  }

  const targetId = Number(args[0]);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    await ctx.replyWithHTML('❌ Неверный Telegram ID. Используйте: <code>/sheet_access 123456789</code>');
    return;
  }

  const added = addSheetAccessUser(targetId);
  if (added) {
    await ctx.replyWithHTML(`✅ Доступ к Таблицам предоставлен для <code>${targetId}</code>\n\nПользователь увидит кнопку «📋 Таблицы» в Настройках.`);
  } else {
    await ctx.replyWithHTML(`ℹ️ Пользователь <code>${targetId}</code> уже имеет доступ.`);
  }
});

bot.command('role', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) {
    return;
  }

  const args = (ctx.message.text || '').replace(/^\/role\s*/, '').trim().split(/\s+/);

  if (args.length < 2) {
    await ctx.replyWithHTML(
      '🔑 <b>Смена роли</b>\n\n' +
      'Использование: <code>/role &lt;telegram_id&gt; &lt;courier|logist&gt;</code>\n\n' +
      'Примеры:\n' +
      '<code>/role 123456789 courier</code> — сделать курьером\n' +
      '<code>/role 123456789 logist</code> — сделать логистом'
    );
    return;
  }

  const targetId = args[0];
  const newRole = args[1].toLowerCase();

  if (newRole !== 'courier' && newRole !== 'logist') {
    await ctx.replyWithHTML('❌ Роль должна быть <code>courier</code> или <code>logist</code>.');
    return;
  }

  const currentFio = getUserField(targetId, 'fio');
  if (!currentFio) {
    await ctx.replyWithHTML(`❌ Пользователь <code>${targetId}</code> не найден.`);
    return;
  }

  const oldRole = getUserRole(targetId);
  const displayRole = newRole === 'logist' ? 'Логист' : 'Курьер';
  const oldDisplayRole = oldRole === 'logist' ? 'Логист' : 'Курьер';

  setUserField(targetId, 'role', newRole);

  if (newRole === 'logist') {
    const carNumber = getUserField(targetId, 'carNumber');
    const device = getUserField(targetId, 'device');
    if (carNumber) setUserField(targetId, 'carNumber', null);
    if (device) setUserField(targetId, 'device', null);
  }

  await ctx.replyWithHTML(
    `✅ Роль изменена: <b>${esc(currentFio)}</b> (<code>${targetId}</code>)\n\n` +
    `${oldDisplayRole} → ${displayRole}`
  );
});

function formatNoSheetMessage(result, workplace) {
  if (result?.noSheetForMonth && result?.monthKey) {
    return `❌ Для магазина <b>${esc(workplace)}</b> не привязана таблица на месяц <code>${esc(result.monthKey)}</code>.\nОбратитесь к администратору.`;
  }

  if (result?.noSheet) {
    return '❌ Таблица не привязана для вашего магазина.\nОбратитесь к администратору.';
  }

  return '❌ Не удалось найти сотрудника в таблице.';
}

const ocrFeedbackPath = path.join(__dirname, 'ocr_feedback.json');
const MAX_OCR_FEEDBACK = LIMITS.MAX_OCR_FEEDBACK;

function logOcrFeedback(telegramId, ocrMileage, confirmedMileage) {
  if (!Number.isFinite(confirmedMileage) || confirmedMileage <= 0) return;
  if (ocrMileage === confirmedMileage) return;

  try {
    let feedback = [];
    try {
      if (fs.existsSync(ocrFeedbackPath)) {
        feedback = JSON.parse(fs.readFileSync(ocrFeedbackPath, 'utf8'));
      }
    } catch (e) { /* ignore */ }

    feedback.push({
      ocr: ocrMileage,
      confirmed: confirmedMileage,
      diff: confirmedMileage - (ocrMileage || 0),
      date: new Date().toISOString(),
      userId: telegramId
    });

    if (feedback.length > MAX_OCR_FEEDBACK) {
      feedback = feedback.slice(-MAX_OCR_FEEDBACK);
    }

    fs.writeFileSync(ocrFeedbackPath, JSON.stringify(feedback, null, 2), 'utf8');
  } catch (error) {
    console.error('OCR feedback log error', error.message);
  }
}

function parseMileageNumber(value) {
  const text = String(value || '').replace(/\D/g, '');
  if (!text) return null;

  const number = Number(text);
  if (!Number.isInteger(number)) return null;
  if (text.length < 2 || text.length > 6) return null;

  return number;
}

function getMaxShiftMileageDelta() {
  const value = Number(process.env.OCR_MAX_SHIFT_DELTA || 800);
  if (!Number.isFinite(value) || value < 0) return 800;
  return value;
}

async function buildMileageRecognitionOptions(state) {
  const options = {
    minMileage: getMinMileageThreshold(),
    maxMileage: null,
    stage: state?.stage || null
  };

  if (state?.stage === 'end') {
    try {
      const startCell = getMileageStageCell(state, 'start');
      if (startCell) {
        const sheetContext = resolveSheetInfo(startCell.workplace);
        if (sheetContext.sheetId) {
          const startRaw = await readCell(startCell.sheetName, startCell.cell, sheetContext.sheetId);
          const startMileage = parseMileageNumber(startRaw);
          if (startMileage) {
            options.maxMileage = startMileage + getMaxShiftMileageDelta();
            options.startMileage = startMileage;
            options.minMileage = Math.max(options.minMileage, startMileage);
          }
        }
      }
    } catch (error) {
      console.error('mileage recognition options error (stage=end)', error.message || error);
    }
  } else if (state?.stage === 'start') {
    try {
      const endCell = getMileageStageCell(state, 'end');
      if (endCell) {
        const sheetContext = resolveSheetInfo(endCell.workplace);
        if (sheetContext.sheetId) {
          const endRaw = await readCell(endCell.sheetName, endCell.cell, sheetContext.sheetId);
          const prevEndMileage = parseMileageNumber(endRaw);
          if (prevEndMileage) {
            const prevMinMileage = Math.max(prevEndMileage - getMaxShiftMileageDelta(), getMinMileageThreshold());
            options.minMileage = prevMinMileage;
            options.prevEndMileage = prevEndMileage;
          }
        }
      }
    } catch (error) {
      console.error('mileage recognition options error (stage=start)', error.message || error);
    }
  }

  return options;
}

function getMileageColumnsForState(workplace, day) {
  const base = getMileageColumnsByDay(day);
  const offset = getSheetConfig(workplace)?.mileageDayOffset || 0;

  return {
    startColumn: base.startColumn + offset,
    endColumn: base.endColumn + offset,
    totalColumn: base.totalColumn + offset
  };
}

function getMileageStageCell(state, stage = state?.stage) {
  if (!state?.mileageRow || !state?.day) return null;

  const workplace = state.workplace || getUserField(state.telegramId, 'workplace');
  if (!workplace) return null;

  const config = getSheetConfig(workplace);
  const columns = getMileageColumnsForState(workplace, state.day);
  const column = stage === 'start' ? columns.startColumn : columns.endColumn;

  return {
    workplace,
    sheetName: config.mileageSheet,
    cell: `${getColumnLetter(column)}${state.mileageRow}`
  };
}

registerSheetCommand(bot, { esc, workplaces: WORKPLACES, isAdminUser });

bot.command('cancel', async (ctx) => {
  await backToMainMenu(ctx);
});

bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await backToMainMenu(ctx);
});

bot.action('show_my_id', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';
  const username = ctx.from.username ? `@${ctx.from.username}` : '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';

  await ctx.replyWithHTML(
    `🆔 <b>Ваш Telegram ID:</b> <code>${userId}</code>\n\n` +
    'Отправьте этот ID администратору для получения доступа.'
  );

  // Параллельно уведомляем админов
  for (const adminId of getAdminIds()) {
    try {
      await ctx.telegram.sendMessage(adminId,
        `🆔 <b>Запрос доступа к Таблицам</b>\n\n` +
        `👤 ${esc(displayName)} ${esc(username)}\n` +
        `🆔 <code>${userId}</code>\n\n` +
        `Дать доступ: <code>/sheet_access ${userId}</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { /* админ заблокирован — пропускаем */ }
  }
});

bot.action('issues_back', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (e) { /* сообщение уже удалено */ }
  await backToMainMenu(ctx);
});

bot.action(/^lb_wp_(east|center|all)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const workplace = ctx.match[1];
  try { await ctx.deleteMessage(); } catch {}
  await showLeaderboardTypeMenu(ctx, workplace);
});

bot.action(/^lb_day_(east|center|all)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const workplace = ctx.match[1];
  try { await ctx.deleteMessage(); } catch {}
  await showLeaderboardPeriods(ctx, workplace);
});

bot.action(/^lb_total_(east|center|all)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const workplace = ctx.match[1];
  try { await ctx.deleteMessage(); } catch {}
  await showLeaderboardResult(ctx, 'total', null, workplace);
});

bot.action(/^lb_p_(\d+)_(east|center|all)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const days = Number(ctx.match[1]);
  const workplace = ctx.match[2];
  try { await ctx.deleteMessage(); } catch {}
  await showLeaderboardResult(ctx, 'max', days, workplace);
});

bot.action('lb_back', async (ctx) => {
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch {}
  await showLeaderboardMenu(ctx);
});

bot.action('route_sheet_done', async (ctx) => {
  await ctx.answerCbQuery('Готово');
  const state = getState(ctx.from.id);
  // Отчётом завершения может быть и «маршрутный лист», и «сверки»
  // (обе используют routeSheetKeyboard). Сообщение нейтрально — просто
  // финализируем и возвращаем в меню.
  clearState(ctx.from.id);
  if (state?.awaitingReconciliationPhoto) {
    const sent = state.reconciliationPhotosSent || 0;
    await ctx.replyWithHTML(
      sent > 0
        ? `✅ Завершено. Отправлено фото: <b>${sent}</b>.`
        : '✅ Завершено. Фото не отправлены.',
      mainMenu()
    );
    return;
  }
  await ctx.replyWithHTML('✅ Завершено. Спасибо.', mainMenu());
});

bot.action('help_commands', async (ctx) => {
  await ctx.answerCbQuery();
  await sendCommandsList(ctx);
});

bot.action('confirm_switch_user', async (ctx) => {
  await ctx.answerCbQuery();
  const role = getUserRole(ctx.from.id);
  deleteUser(ctx.from.id);
  setState(ctx.from.id, { awaitingFio: true });
  await ctx.replyWithHTML('👤 <b>Смена сотрудника</b>\n\nПредыдущие данные удалены.\nВведите имя и фамилию как в таблице.', getMenuForRole(ctx.from.id));
});

bot.action('role_courier', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id;
  const state = getState(telegramId);
  if (!state?.awaitingRoleChoice) {
    await ctx.replyWithHTML('⚠️ Выбор роли устарел. Нажмите /start.', getMenuForRole(telegramId));
    return;
  }
  setUserField(telegramId, 'role', 'courier');
  clearState(telegramId);
  await ctx.replyWithHTML('✅ Роль: <b>Курьер</b>\n\nТеперь введите номер машины.');
  await askForCarNumber(ctx, state.fio);
});

bot.action('role_logist', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id;
  const state = getState(telegramId);
  if (!state?.awaitingRoleChoice) {
    await ctx.replyWithHTML('⚠️ Выбор роли устарел. Нажмите /start.', getMenuForRole(telegramId));
    return;
  }
  setUserField(telegramId, 'role', 'logist');
  clearState(telegramId);
  await ctx.replyWithHTML('✅ Роль: <b>Логист</b>\n\nТеперь выберите ваш магазин.', logistMainMenu());
  await askForWorkplace(ctx, state.fio);
});

bot.action('cash_submit_yes', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id;
  const pendingCash = getUserField(telegramId, 'pendingCashToSubmit');
  const amount = Number(pendingCash?.amount || 0);

  if (!Number.isFinite(amount) || amount < 1) {
    await ctx.replyWithHTML('✅ Долгов нет — все деньги сданы.', getMenuForRole(telegramId));
    return;
  }

  const formatted = pendingCash?.formatted || formatMoneyRu(amount);
  const courierFio = getUserField(telegramId, 'fio') || 'Неизвестный';
  const workplace = pendingCash?.workplace || getUserField(telegramId, 'workplace') || 'не указано';

  setCashConfirmationStatus(telegramId, 'awaiting');

  logCashAction({
    logistId: null,
    logistFio: null,
    courierId: String(telegramId),
    courierFio: courierFio,
    workplace: workplace,
    amount: amount,
    action: 'self_cleared_requested'
  });

  await notifyLogistsAboutSelfClearance(telegramId, courierFio, amount, formatted, workplace);

  try {
    await ctx.editMessageText('⏳ Запрос отправлен. Ожидайте подтверждения логиста.');
  } catch (e) { /* ignore */ }

  await ctx.replyWithHTML(
    `⏳ <b>Запрос отправлен</b>\n\n` +
    `Вы отметили сдачу <code>${esc(formatted)}</code> ₽.\n` +
    `Ожидайте подтверждения от логиста.`,
    getMenuForRole(telegramId)
  );
});

bot.action('cash_submit_no', async (ctx) => {
  await ctx.answerCbQuery();
  const fun = String(process.env.FUN_TONE || '').toLowerCase() === 'true';
  const message = fun
    ? '😼 Тогда бегом сдавать деньги! Котоконтроль не дремлет 🐾\n\nКогда сдадите — нажмите «💵 Деньги к сдаче» и подтвердите.'
    : '⚠️ Не забудьте сдать деньги.\n\nКогда сдадите — нажмите «💵 Деньги к сдаче» и подтвердите.';
  await ctx.replyWithHTML(message, getMenuForRole(telegramId));
});

bot.action(/^d_(\d+)$/, async (ctx) => {
  const courierId = ctx.match[1];
  await pokeCourier(ctx, courierId);
});

bot.action(/^ack_([0-9a-f]+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  await ctx.answerCbQuery();

  const reminder = getReminder(shortId);
  if (!reminder) {
    try { await ctx.editMessageText('⚠️ Напоминание устарело или уже обработано.'); } catch (e) { /* ignore */ }
    return;
  }

  if (reminder.status !== 'reminded' && reminder.status !== 'acknowledged') {
    try { await ctx.editMessageText('⚠️ Напоминание уже обработано.'); } catch (e) { /* ignore */ }
    return;
  }

  updateReminder(shortId, { status: 'acknowledged' });

  const courierFio = reminder.courierFio;
  const formatted = reminder.formatted;
  const logistId = reminder.logistId;

  logCashAction({
    logistId: logistId,
    logistFio: reminder.logistFio,
    courierId: reminder.courierId,
    courierFio: courierFio,
    workplace: reminder.workplace,
    amount: reminder.amount,
    action: 'acknowledged'
  });

  try {
    await ctx.editMessageText(
      `✅ Отметка получена. Когда сдадите — нажмите «Сдал».\n\n` +
      `💶 К сдаче: <code>${esc(formatted)}</code> ₽`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('✅ Сдал', `c_${shortId}`)]
          ]
        }
      }
    );
  } catch (e) { /* ignore */ }

  try {
    await bot.telegram.sendMessage(logistId,
      `🏃 <b>${esc(courierFio)}</b> уже бежит сдавать <code>${esc(formatted)}</code> ₽`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('failed to notify logist about acknowledgement', e.message);
  }
});

bot.action(/^c_([0-9a-f]+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  await ctx.answerCbQuery();

  const reminder = getReminder(shortId);
  if (!reminder) {
    try { await ctx.editMessageText('⚠️ Напоминание устарело или уже обработано.'); } catch (e) { /* ignore */ }
    return;
  }

  if (reminder.status === 'approved' || reminder.status === 'declined') {
    try { await ctx.editMessageText('✅ Наличные уже обработаны.'); } catch (e) { /* ignore */ }
    return;
  }

  updateReminder(shortId, { status: 'confirmed' });

  logCashAction({
    logistId: reminder.logistId,
    logistFio: reminder.logistFio,
    courierId: reminder.courierId,
    courierFio: reminder.courierFio,
    workplace: reminder.workplace,
    amount: reminder.amount,
    action: 'confirmed'
  });

  try {
    await ctx.editMessageText('⏳ Логист проверяет...', { parse_mode: 'HTML' });
  } catch (e) { /* ignore */ }

  try {
    const sent = await bot.telegram.sendMessage(reminder.logistId,
      `✅ <b>${esc(reminder.courierFio)}</b> сдал <code>${esc(reminder.formatted)}</code> ₽\n\nПодтвердите сдачу:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('✅ Подтвердить', `appr_${shortId}`)],
            [Markup.button.callback('❌ Отклонить', `decl_${shortId}`)]
          ]
        }
      }
    );
    updateReminder(shortId, { logistMsgId: sent.message_id });
  } catch (e) {
    console.error('failed to notify logist about confirmation', e.message);
  }
});

bot.action(/^appr_([0-9a-f]+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  await ctx.answerCbQuery();

  const reminder = getReminder(shortId);
  if (!reminder) {
    try { await ctx.editMessageText('⚠️ Напоминание устарело.'); } catch (e) { /* ignore */ }
    return;
  }

  clearPendingCashAndReminders(reminder.courierId);

  logCashAction({
    logistId: reminder.logistId,
    logistFio: reminder.logistFio,
    courierId: reminder.courierId,
    courierFio: reminder.courierFio,
    workplace: reminder.workplace,
    amount: reminder.amount,
    action: 'approved'
  });

  deleteReminder(shortId);

  try {
    await ctx.editMessageText(`✅ Подтверждено: <b>${esc(reminder.courierFio)}</b> сдал <code>${esc(reminder.formatted)}</code> ₽`, { parse_mode: 'HTML' });
  } catch (e) { /* ignore */ }

  try {
    await bot.telegram.sendMessage(reminder.courierId,
      `✅ <b>${esc(reminder.logistFio)}</b> подтвердил сдачу <code>${esc(reminder.formatted)}</code> ₽\n\nСпасибо!`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('failed to notify courier about approval', e.message);
  }

  await sendFunReaction(ctx, 'success');
});

bot.action(/^decl_([0-9a-f]+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  await ctx.answerCbQuery();

  const reminder = getReminder(shortId);
  if (!reminder) {
    try { await ctx.editMessageText('⚠️ Напоминание устарело.'); } catch (e) { /* ignore */ }
    return;
  }

  logCashAction({
    logistId: reminder.logistId,
    logistFio: reminder.logistFio,
    courierId: reminder.courierId,
    courierFio: reminder.courierFio,
    workplace: reminder.workplace,
    amount: reminder.amount,
    action: 'declined'
  });

  updateReminder(shortId, { status: 'declined' });

  try {
    await ctx.editMessageText(`❌ Отклонено: <b>${esc(reminder.courierFio)}</b>`, { parse_mode: 'HTML' });
  } catch (e) { /* ignore */ }

  try {
    await bot.telegram.sendMessage(reminder.courierId,
      `❌ <b>${esc(reminder.logistFio)}</b> отклонил сдачу.\n\nПроверьте сумму и нажмите «Сдал» снова.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('✅ Сдал', `c_${shortId}`)]
          ]
        }
      }
    );
  } catch (e) {
    console.error('failed to notify courier about decline', e.message);
  }
});

bot.action(/^sc_appr_(\d+)$/, async (ctx) => {
  const courierId = ctx.match[1];
  await ctx.answerCbQuery();

  const pendingCash = getUserField(courierId, 'pendingCashToSubmit');
  if (!pendingCash || pendingCash.confirmationStatus !== 'awaiting') {
    try { await ctx.editMessageText('✅ Уже подтверждено другим логистом.'); } catch (e) { /* ignore */ }
    return;
  }

  const courierFio = getUserField(courierId, 'fio') || 'Неизвестный';
  const amount = Number(pendingCash.amount || 0);
  const formatted = pendingCash.formatted || formatMoneyRu(amount);
  const workplace = pendingCash.workplace || getUserField(courierId, 'workplace') || 'не указано';
  const logistId = String(ctx.from.id);
  const logistFio = getUserField(logistId, 'fio') || 'Логист';

  clearPendingCashAndReminders(courierId);

  logCashAction({
    logistId: logistId,
    logistFio: logistFio,
    courierId: courierId,
    courierFio: courierFio,
    workplace: workplace,
    amount: amount,
    action: 'approved'
  });

  try {
    await ctx.editMessageText(`✅ Подтверждено: <b>${esc(courierFio)}</b> сдал <code>${esc(formatted)}</code> ₽`, { parse_mode: 'HTML' });
  } catch (e) { /* ignore */ }

  try {
    await bot.telegram.sendMessage(courierId,
      `✅ <b>${esc(logistFio)}</b> подтвердил сдачу <code>${esc(formatted)}</code> ₽\n\nСпасибо!`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('failed to notify courier about sc approval', e.message);
  }
});

bot.action(/^sc_decl_(\d+)$/, async (ctx) => {
  const courierId = ctx.match[1];
  await ctx.answerCbQuery();

  const pendingCash = getUserField(courierId, 'pendingCashToSubmit');
  if (!pendingCash || pendingCash.confirmationStatus !== 'awaiting') {
    try { await ctx.editMessageText('⚠️ Запрос уже обработан.'); } catch (e) { /* ignore */ }
    return;
  }

  setCashConfirmationStatus(courierId, null);

  const courierFio = getUserField(courierId, 'fio') || 'Неизвестный';
  const logistId = String(ctx.from.id);
  const logistFio = getUserField(logistId, 'fio') || 'Логист';

  logCashAction({
    logistId: logistId,
    logistFio: logistFio,
    courierId: courierId,
    courierFio: courierFio,
    workplace: pendingCash.workplace || 'не указано',
    amount: Number(pendingCash.amount || 0),
    action: 'declined'
  });

  try {
    await ctx.editMessageText(`❌ Отклонено: <b>${esc(courierFio)}</b>`, { parse_mode: 'HTML' });
  } catch (e) { /* ignore */ }

  try {
    await bot.telegram.sendMessage(courierId,
      `❌ <b>${esc(logistFio)}</b> отклонил сдачу.\n\nПроверьте сумму и попробуйте снова.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('failed to notify courier about sc decline', e.message);
  }
});

bot.action(/^ch_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const dateStr = ctx.match[1];
  await ctx.answerCbQuery();
  await showCashHistoryForDate(ctx, dateStr);
});

bot.action('edit_time', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  if (!state?.awaitingTimeChange || !state?.courierRow || !state?.day || !state?.stage) {
    await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.punchTime}».`, getMenuForRole(ctx.from.id));
    return;
  }

  setState(ctx.from.id, {
    ...state,
    awaitingTimeChange: false,
    awaitingManualTime: true
  });

  await ctx.replyWithHTML(
    `✏️ <b>Изменение времени</b>\n\n` +
    `Этап: <b>${esc(formatStage(state.stage))}</b>\n\n` +
    `Введите время в любом формате:\n` +
    `• целое число — <code>7</code>\n` +
    `• с половиной — <code>7,5</code> или <code>7.5</code>\n` +
    `• часы:минуты — <code>07:30</code>, <code>07:44</code>, <code>08.46</code>, <code>8 14</code>\n\n` +
    `Минуты округлятся до ближайших 30 (08:14 → 8, 08:46 → 9).`,
    getMenuForRole(ctx.from.id)
  );
});

bot.action('retry_mileage_photo', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  if (!state?.mileageRow || !state?.day || !state?.stage) {
    await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.mileage}».`, mainMenu());
    return;
  }

  setState(ctx.from.id, {
    ...state,
    awaitingMileagePhoto: true,
    awaitingManualMileage: false,
    recognizedMileage: null,
    ocrValue: null
  });

  await ctx.replyWithHTML('📷 Отправьте новое фото пробега крупным планом или нажмите «⏭️ Пропустить».', skipMileageKeyboard());
});

async function replaceMileageFlow(ctx, stage) {
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return;
  }

  try {
    const result = await prepareMileage(profile.fio, profile.workplace, stage);

    if (result.notFound) {
      const msg = formatNoSheetMessage(result, profile.workplace);
      await ctx.replyWithHTML(msg);
      return;
    }

    setState(ctx.from.id, makeMileageState(ctx.from.id, applyProfile(result, profile), { source: 'mileage' }));
    console.log('ожидание замены пробега', stage);
    await ctx.replyWithHTML(`📷 <b>Замена пробега</b>\n\nОтправьте фото для: <b>${esc(formatStage(stage))}</b>`, skipMileageKeyboard());
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await ctx.replyWithHTML('⚠️ Не удалось подготовить замену пробега.\nПопробуйте ещё раз или обратитесь к администратору.');
  }
}

bot.action('replace_mileage_start', async (ctx) => {
  await ctx.answerCbQuery();
  await replaceMileageFlow(ctx, 'start');
});

bot.action('replace_mileage_end', async (ctx) => {
  await ctx.answerCbQuery();
  await replaceMileageFlow(ctx, 'end');
});

// Фабрика обработчиков для replace_start / replace_end. Раньше это были
// два почти идентичных блока по 25 строк, отличающихся лишь stage и иконкой.
function replaceTimeAction(stage) {
  return async (ctx) => {
    await ctx.answerCbQuery();
    const profile = await ensureProfile(ctx);
    if (!profile) return;

    try {
      const result = await replaceTime(profile.fio, profile.workplace, stage);

      if (result.notFound) {
        await ctx.replyWithHTML(formatNoSheetMessage(result, profile.workplace));
        return;
      }

      console.log('время записано', `replace_${stage}`);
      clearState(ctx.from.id);
      const icon = stage === 'start' ? '🟢' : '🔴';
      const label = stage === 'start' ? 'Старт' : 'Конец';
      await ctx.replyWithHTML(
        `${icon} <b>${label} смены</b> заменён: <code>${esc(result.timeValue)}</code>`,
        getMenuForRole(ctx.from.id)
      );
    } catch (error) {
      console.error('ошибка Google Sheets', error);
      await ctx.replyWithHTML('⚠️ Не удалось записать время.\nПопробуйте ещё раз или обратитесь к администратору.');
    }
  };
}

bot.action('replace_start', replaceTimeAction('start'));
bot.action('replace_end', replaceTimeAction('end'));

bot.action('skip_mileage', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  const photoReceived = Boolean(state?.photoReceived);
  const savedMileage = state?.savedMileage;

  clearState(ctx.from.id);
  console.log('пропуск пробега', { photoReceived });

  const message = savedMileage
    ? '⬅️ Возвращаю в меню.'
    : photoReceived
      ? '⬅️ Возвращаю в меню. Пробег не сохранён.'
      : '⏭️ Пробег пропущен.';

  await ctx.replyWithHTML(message, mainMenu());
});

bot.action('edit_mileage', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  if (!state?.mileageRow || !state?.day || !state?.stage) {
    await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.mileage}».`, mainMenu());
    return;
  }

  setState(ctx.from.id, { ...state, awaitingManualMileage: true, awaitingMileagePhoto: false });
  await ctx.replyWithHTML('✏️ <b>Ввод пробега вручную</b>\n\nВведите пробег только цифрами или загрузите фото повторно.', manualMileageKeyboard());
});

async function handleRouteSheetPhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  console.log('фото маршрутного листа получено');
  const date = getTodayText();
  const routeSheetNumber = getNextRouteSheetNumber(state, date);
  logRouteSheetPhoto(telegramId, fileId, state, date, routeSheetNumber);

  try {
    const forwarded = await sendPhotoToRouteSheetChat(ctx, fileId, buildRouteSheetCaption(state, routeSheetNumber));

    if (!forwarded) {
      await ctx.replyWithHTML('⚠️ Временные проблемы с отправкой.\nСообщите администратору.', routeSheetKeyboard());
      return;
    }

    await ctx.replyWithHTML(`✅ <b>Маршрутный лист №${routeSheetNumber}</b> отправлен.\n\nМожно отправить ещё одно фото.`, routeSheetKeyboard());
  } catch (error) {
    console.error('telegram send route sheet photo error', error);
    await ctx.replyWithHTML('⚠️ Не удалось отправить фото.\nПопробуйте ещё раз или обратитесь к администратору.', routeSheetKeyboard());
  }
}

async function handleReconciliationPhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  const photosSent = (state.reconciliationPhotosSent || 0) + 1;
  const total = state.reconciliationTotal || 1;
  const isTerminal = state.device === 'Терминал';
  const isTerminalFirstPhoto = isTerminal && photosSent === 1;

  if (isTerminalFirstPhoto) {
    const cashInfo = await recognizeReconciliationCashSafe(ctx, fileId, 'terminal_first_photo');
    const shouldAttachCash = cashInfo.valid && Number(cashInfo.amount) >= 1 && Number(cashInfo.orders) > 0;
    const cashFormatted = shouldAttachCash ? formatMoneyRu(cashInfo.amount) : null;

    const captionLines = [
      `📊 Сверки — Терминал (статистика)`,
      `👤 ${esc(getEmployeeDisplayName(state.fio))}`,
      `🏬 ${esc(state.workplace || 'не указано')}`
    ];

    if (shouldAttachCash && cashFormatted) {
      const previousPending = getUserField(telegramId, 'pendingCashToSubmit');
      const previousAmount = Number(previousPending?.amount || 0);
      const totalAmount = Number.isFinite(previousAmount) && previousAmount >= 1
        ? previousAmount + cashInfo.amount
        : cashInfo.amount;
      const totalFormatted = formatMoneyRu(totalAmount);
      const currentNumberOnly = formatMoneyRuNumber(cashInfo.amount) || String(cashFormatted).replace(/\s*₽$/, '');

      captionLines.push(`💵 К сдаче в следующую смену: <code>${esc(currentNumberOnly)}</code> ₽`);

      setUserField(telegramId, 'pendingCashToSubmit', {
        amount: totalAmount,
        formatted: totalFormatted,
        orders: cashInfo.orders,
        workplace: state.workplace || null,
        sourceLabel: 'Терминал',
        updatedAt: new Date().toISOString(),
        fileId
      });
    }

    const caption = truncateCaption(captionLines.join('\n'));

    console.log('фото сверок получено', `${photosSent}/${total}`, '(статистика)');
    logReconciliationPhoto(telegramId, fileId, state, 'Терминал (статистика)');
    appendLog(reconciliationLogPath, {
      at: new Date().toISOString(),
      type: 'cash_detection',
      telegramId,
      fileId,
      workplace: state?.workplace || null,
      label: 'Терминал (статистика)',
      cashOrders: cashInfo.orders,
      cashAmount: cashInfo.amount,
      totalOrders: cashInfo.totalOrders,
      cashApplied: Boolean(shouldAttachCash),
      reason: cashInfo.reason || null
    });

    setState(telegramId, {
      ...state,
      reconciliationPhotosSent: photosSent,
      reconciliationPhoto1FileId: fileId,
      reconciliationPhoto1Caption: caption,
      reconciliationPhoto1TotalOrders: cashInfo.totalOrders || null,
      reconciliationPhoto1OcrReason: cashInfo.reason || null
    });

    await ctx.replyWithHTML(
      `✅ Фото <b>1</b> из <b>2</b> (статистика) получено.\n\n` +
      `📷 Теперь отправьте фото <b>2 из 2</b>: <b>🧾 Чек</b>`,
      routeSheetKeyboard()
    );
    return;
  }

  if (isTerminal && photosSent === 2) {
    console.log('фото сверок получено', `${photosSent}/${total}`, '(чек)');
    logReconciliationPhoto(telegramId, fileId, state, 'Терминал (чек)');
    appendLog(reconciliationLogPath, {
      at: new Date().toISOString(),
      type: 'cash_detection',
      telegramId,
      fileId,
      workplace: state?.workplace || null,
      label: 'Терминал (чек)',
      cashOrders: 0,
      cashAmount: 0,
      cashApplied: false,
      reason: 'чек — OCR пропущен'
    });

    const photo1FileId = state.reconciliationPhoto1FileId;
    const photo1Caption = state.reconciliationPhoto1Caption || '';

    try {
      const forwarded = await sendMediaGroupToReconciliationChat(ctx, [
        { fileId: photo1FileId, caption: photo1Caption },
        { fileId, caption: '' }
      ]);

      if (!forwarded) {
        await ctx.replyWithHTML('⚠️ Временные проблемы с отправкой.\nСообщите администратору.', routeSheetKeyboard());
        return;
      }

      clearState(telegramId);
      const ocrWarning = !state.reconciliationPhoto1TotalOrders && state.reconciliationPhoto1OcrReason
        ? `\n\n⚠️ OCR не распознал заказы/наличные. Фото отправлены, но данные не записаны автоматически.`
        : '';
      await ctx.replyWithHTML(`✅ <b>Все фото (2 шт.) отправлены.</b>${ocrWarning}`, mainMenu());

      const totalOrders = state.reconciliationPhoto1TotalOrders;
      if (totalOrders && totalOrders > 0 && state.fio && state.workplace) {
        const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
        const { day } = getCurrentDateInfo(timezone);
        try {
          const result = await updateEfficiencyOrders(state.fio, state.workplace, day, totalOrders);
          if (result.ok) {
            console.log(`эффективность: записано ${totalOrders} заказов для ${state.fio}, день ${day}, ячейка ${result.cell}`);
          } else {
            console.error('эффективность: не удалось записать', result.error);
          }
        } catch (effError) {
          console.error('эффективность: ошибка записи', effError.message || effError);
        }
        try {
          recordLeaderboardOrders(String(telegramId), state.fio, state.workplace, totalOrders);
          await handleLeaderboardNotifications(ctx, String(telegramId), state.fio, state.workplace, totalOrders);
        } catch (lbErr) {
          console.error('leaderboard record error', lbErr.message || lbErr);
        }
      }
    } catch (error) {
      console.error('telegram send reconciliation album error', error);
      await ctx.replyWithHTML('⚠️ Не удалось отправить фото.\nПопробуйте ещё раз или обратитесь к администратору.', routeSheetKeyboard());
    }
    return;
  }

  const label = 'Пин-Панель';
  const cashInfo = await recognizeReconciliationCashSafe(ctx, fileId, 'pin_panel');
  const shouldAttachCash = cashInfo.valid && Number(cashInfo.amount) >= 1 && Number(cashInfo.orders) > 0;
  const cashFormatted = shouldAttachCash ? formatMoneyRu(cashInfo.amount) : null;

  const captionLines = [
    `📊 Сверки — ${esc(label)}`,
    `👤 ${esc(getEmployeeDisplayName(state.fio))}`,
    `🏬 ${esc(state.workplace || 'не указано')}`
  ];

  if (shouldAttachCash && cashFormatted) {
    const previousPending = getUserField(telegramId, 'pendingCashToSubmit');
    const previousAmount = Number(previousPending?.amount || 0);
    const totalAmount = Number.isFinite(previousAmount) && previousAmount >= 1
      ? previousAmount + cashInfo.amount
      : cashInfo.amount;
    const totalFormatted = formatMoneyRu(totalAmount);
    const currentNumberOnly = formatMoneyRuNumber(cashInfo.amount) || String(cashFormatted).replace(/\s*₽$/, '');

    captionLines.push(`💵 К сдаче в следующую смену: <code>${esc(currentNumberOnly)}</code> ₽`);

    setUserField(telegramId, 'pendingCashToSubmit', {
      amount: totalAmount,
      formatted: totalFormatted,
      orders: cashInfo.orders,
      workplace: state.workplace || null,
      sourceLabel: label,
      updatedAt: new Date().toISOString(),
      fileId
    });
  }

  const caption = truncateCaption(captionLines.join('\n'));

  console.log('фото сверок получено', `${photosSent}/${total}`);
  logReconciliationPhoto(telegramId, fileId, state, label);
  appendLog(reconciliationLogPath, {
    at: new Date().toISOString(),
    type: 'cash_detection',
    telegramId,
    fileId,
    workplace: state?.workplace || null,
    label,
    cashOrders: cashInfo.orders,
    cashAmount: cashInfo.amount,
    totalOrders: cashInfo.totalOrders,
    cashApplied: Boolean(shouldAttachCash),
    reason: cashInfo.reason || null
  });

  try {
    const forwarded = await sendPhotoToReconciliationChat(ctx, fileId, caption);

    if (!forwarded) {
      await ctx.replyWithHTML('⚠️ Временные проблемы с отправкой.\nСообщите администратору.', routeSheetKeyboard());
      return;
    }

    clearState(telegramId);
    const ocrWarning = shouldWarnAboutReconciliationOcr(cashInfo)
      ? `\n\n⚠️ OCR не распознал заказы/наличные. Фото отправлено, но данные не записаны автоматически.`
      : '';
    await ctx.replyWithHTML(`✅ <b>Все фото (${total} шт.) отправлены.</b>${ocrWarning}`, mainMenu());

    const totalOrders = cashInfo.totalOrders;
    if (totalOrders && totalOrders > 0 && state.fio && state.workplace) {
      const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
      const { day } = getCurrentDateInfo(timezone);
      try {
        const result = await updateEfficiencyOrders(state.fio, state.workplace, day, totalOrders);
        if (result.ok) {
          console.log(`эффективность: записано ${totalOrders} заказов для ${state.fio}, день ${day}, ячейка ${result.cell}`);
        } else {
          console.error('эффективность: не удалось записать', result.error);
        }
      } catch (effError) {
        console.error('эффективность: ошибка записи', effError.message || effError);
      }
      try {
        recordLeaderboardOrders(String(telegramId), state.fio, state.workplace, totalOrders);
        await handleLeaderboardNotifications(ctx, String(telegramId), state.fio, state.workplace, totalOrders);
      } catch (lbErr) {
        console.error('leaderboard record error', lbErr.message || lbErr);
      }
    }
  } catch (error) {
    console.error('telegram send reconciliation photo error', error);
    await ctx.replyWithHTML('⚠️ Не удалось отправить фото.\nПопробуйте ещё раз или обратитесь к администратору.', routeSheetKeyboard());
  }
}

async function handleMileagePhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  console.log('фото получено');
  logMileagePhoto(telegramId, fileId, state);

  const photoState = {
    ...state,
    awaitingMileagePhoto: false,
    awaitingManualMileage: false,
    photoReceived: true,
    fileId
  };
  setState(telegramId, photoState);

  const ocrAvailable = isRapidOcrEnabled();
  if (!ocrAvailable) {
    setState(telegramId, {
      ...photoState,
      awaitingMileagePhoto: true,
      awaitingManualMileage: true,
      recognizedMileage: null,
      ocrValue: null
    });
    sendPhotoToWorkChat(ctx, fileId, buildPhotoCaption(state)).catch((error) => {
      console.error('telegram send photo error', error);
    });
    await ctx.replyWithHTML('⚠️ Авто-распознавание сейчас недоступно.\nВведите пробег вручную или нажмите «⏭️ Пропустить».', mileageConfirmKeyboard());
    return;
  }

  await ctx.replyWithHTML('📸 Фото принято. Считываю пробег...');
  await ctx.sendChatAction('typing');

  const [, recognitionOptions] = await Promise.all([
    sendPhotoToWorkChat(ctx, fileId, buildPhotoCaption(state)).catch((error) => {
      console.error('telegram send photo error', error);
    }),
    buildMileageRecognitionOptions(state)
  ]);

  const mileageValue = await recognizeMileage(ctx, fileId, {
    ...recognitionOptions,
    onStatus: async (msg) => {
      try {
        await ctx.replyWithHTML(msg);
      } catch (e) { /* ignore */ }
    }
  });

  if (!mileageValue) {
    setState(telegramId, {
      ...photoState,
      awaitingMileagePhoto: true,
      awaitingManualMileage: true,
      recognizedMileage: null,
      ocrValue: null
    });
    await ctx.replyWithHTML(
      '⚠️ <b>Не удалось распознать пробег</b>\n\nОтправьте фото повторно крупным планом, введите вручную или нажмите «⏭️ Пропустить».',
      mileageConfirmKeyboard()
    );
    return;
  }

  setState(telegramId, { ...photoState, recognizedMileage: mileageValue, ocrValue: mileageValue });
  await saveMileageFromState(ctx, mileageValue);
}

bot.on('photo', async (ctx) => {
  if (isLogist(ctx.from.id)) {
    await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    return;
  }
  const telegramId = ctx.from.id;
  const state = getState(telegramId);

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];
  const fileId = bestPhoto.file_id;

  if (state?.awaitingRouteSheetPhoto) {
    return handleRouteSheetPhoto(ctx, state, fileId);
  }

  if (state?.awaitingReconciliationPhoto) {
    return handleReconciliationPhoto(ctx, state, fileId);
  }

  if (!state?.awaitingMileagePhoto) {
    await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.mileage}».`, mainMenu());
    return;
  }

  return handleMileagePhoto(ctx, state, fileId);
});

async function handleManualTime(ctx, state, text) {
  const telegramId = ctx.from.id;
  const timeValue = normalizeTimeValue(text);

  if (!timeValue) {
    await ctx.replyWithHTML(
      '❌ Неверный формат времени.\n\n' +
      'Поддерживаются: <code>7</code>, <code>7,5</code>, <code>07:30</code>, <code>08:46</code>, <code>08.46</code>, <code>8 14</code> (часы 0–24).\n' +
      'Минуты округляются до ближайших 30.'
    );
    return;
  }

  try {
    await updateCourierTime(state.courierRow, state.day, state.stage, timeValue, state.workplace);
    clearState(telegramId);
    console.log('время изменено', state.stage);
    const icon = state.stage === 'start' ? '🟢' : '🔴';
    const label = state.stage === 'start' ? 'Старт' : 'Конец';
    await ctx.replyWithHTML(`${icon} <b>${label} смены</b> изменён: <code>${esc(timeValue)}</code>`, getMenuForRole(ctx.from.id));
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await ctx.replyWithHTML('⚠️ Не удалось изменить время.\nПопробуйте ещё раз или обратитесь к администратору.');
  }
}

async function requireFio(ctx) {
  const fio = getUserField(ctx.from.id, 'fio');
  if (!fio) {
    await askForFio(ctx);
    return null;
  }
  return fio;
}

// ─── Хендлеры, вынесенные из bot.on('text') для читабельности ───

async function handleSwitchUser(ctx, state, text, telegramId) {
  setState(telegramId, { awaitingSwitchUser: true });
  await ctx.replyWithHTML(
    '⚠️ <b>Смена сотрудника</b>\n\nВсе данные (ФИО, номер машины, магазин, устройство) будут удалены.\n\nВы уверены?',
    switchUserKeyboard()
  );
}

async function handleSheetsInfo(ctx, state, text, telegramId) {
  const hasAccess = isAdminUser(telegramId) || isSheetAccessUser(telegramId) || getUserRole(telegramId) === 'logist';
  if (!hasAccess) {
    // Раньше предлагали «нажмите Мой ID», но эта кнопка спрятана в
    // подменю Управление — пользователь не знал куда идти. Теперь
    // inline-кнопка прямо здесь.
    await ctx.replyWithHTML(
      '⛔ У вас нет доступа к этому разделу.\n\n' +
      'Получите ваш Telegram ID и отправьте его администратору.',
      Markup.inlineKeyboard([
        [Markup.button.callback('🆔 Получить мой ID', 'show_my_id')]
      ])
    );
    return;
  }
  const cm = getCurrentMonthKey();
  const nm = getNextMonthKey();
  let msg = `📋 <b>Привязка таблиц</b>\n\n🗓 Активный месяц: <code>${cm}</code>\n🗓 Следующий месяц: <code>${nm}</code>\n\n`;
  for (const wp of WORKPLACES) {
    const info = resolveSheetInfo(wp);
    const activeId = getWorkplaceSheetIdByMonth(wp, cm);
    const nextId = getWorkplaceSheetIdByMonth(wp, nm);
    msg += `🏬 <b>${esc(wp)}</b>\n`;
    msg += `   Текущий: ${activeId ? '✅ привязана' : '❌ нет'}\n`;
    msg += `   Следующий: ${nextId ? '✅ привязана' : '❌ нет'}\n`;
    msg += `   Источник: ${esc(info.source)}\n\n`;
  }
  msg += `<b>Команды:</b>\n`;
  msg += `<code>/sheet east URL</code> — привязать для ИМ Восток\n`;
  msg += `<code>/sheet center URL</code> — привязать для ИМ Центр\n`;
  msg += `<code>/sheet east active URL</code> — на текущий месяц\n`;
  msg += `<code>/sheet east next URL</code> — на следующий\n`;
  msg += `<code>/sheet</code> — подробный список`;
  await ctx.replyWithHTML(msg);
}

async function handleMyId(ctx) {
  const userId = ctx.from.id;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';
  const username = ctx.from.username ? `@${ctx.from.username}` : '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';

  await ctx.replyWithHTML(
    `🆔 <b>Ваш Telegram ID:</b> <code>${userId}</code>\n\n` +
    'Сообщите этот ID администратору для получения доступа к разделу «📋 Таблицы».'
  );

  await notifyAdmins(
    `🆔 <b>Запрос доступа к Таблицам</b>\n\n` +
    `👤 ${esc(displayName)} ${esc(username)}\n` +
    `🆔 <code>${userId}</code>\n\n` +
    `Дать доступ: <code>/sheet_access ${userId}</code>`
  );
}

async function handleUpdateEditText(ctx, state, text) {
  if (!isAdminUser(ctx.from.id)) {
    clearState(ctx.from.id);
    return;
  }
  const editVersion = state.editVersion;
  const pending = _pendingUpdates[editVersion];
  clearState(ctx.from.id);
  if (!pending) {
    await ctx.replyWithHTML('⚠️ Обновление уже обработано или устарело.');
    return;
  }
  const customHighlights = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
  const fullMessage = (
    `🆕 <b><i>Обновление бота v${esc(editVersion)}</i></b>\n\n` +
    '<b>Коротко, что изменили:</b>\n' +
    customHighlights.map((item) => `• ${esc(item)}`).join('\n') +
    '\n\n💙 Хорошей смены!'
  );
  _pendingUpdates[editVersion] = { ...pending, message: fullMessage };
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Отправить', `upd_send:${editVersion}`),
      Markup.button.callback('✏️ Изменить текст', `upd_edit:${editVersion}`)
    ],
    [Markup.button.callback('⏭️ Пропустить', `upd_skip:${editVersion}`)]
  ]);
  await ctx.replyWithHTML('<b>Предпросмотр:</b>\n\n' + fullMessage, keyboard);
}

async function handleManualMileageInput(ctx, state, text) {
  if (!/^\d{2,6}$/.test(text)) {
    await ctx.replyWithHTML('❌ Введите пробег от <b>2 до 6 цифр</b>.\n\nНапример: <code>25408</code>', manualMileageKeyboard());
    return;
  }
  await saveMileageFromState(ctx, Number(text));
}

// ─── Dispatcher для bot.on('text') ───
// Каждая запись описывает один маршрут. Раньше всё это было ifelse'ами
// длиной в 200+ строк — теперь сразу видно, кто что обрабатывает.
//
// Поля:
//   match(text, state) → bool — кастомное условие (выполняется ПЕРВЫМ если есть)
//   state: 'awaitingFoo' — выполняется при state.awaitingFoo === true
//   button: BUTTONS.foo — точное совпадение текста
//   legacy: ['Старый текст', ...] — алиасы для обратной совместимости
//   handler: (ctx, state, text, telegramId) → Promise
//
// Порядок ВАЖЕН: state-маршруты должны быть выше button-маршрутов,
// чтобы юзер при заполнении формы не «выпадал» в меню.

const TEXT_ROUTES = [
  // 1) «Назад в меню» — общая кнопка
  { match: (text) => ['🏠 В меню', '⬅️ Назад', 'Назад'].includes(text) || text === BUTTONS.back, handler: (ctx) => backToMainMenu(ctx) },

  // 2) State-based: пользователь сейчас что-то вводит
  { state: 'awaitingCarNumber', handler: (ctx, s, text) => saveCarNumber(ctx, text) },
  { state: 'awaitingWorkplace', handler: (ctx, s, text) => saveWorkplace(ctx, text) },
  { state: 'awaitingDevice', handler: (ctx, s, text) => saveDevice(ctx, text) },
  { state: 'awaitingFio', handler: (ctx, s, text) => authorizeFio(ctx, text) },
  { state: 'awaitingRoleChoice', handler: (ctx) => ctx.replyWithHTML('⚠️ Выберите роль кнопкой выше.', roleChoiceKeyboard()) },
  { state: 'awaitingManualTime', handler: (ctx, state, text) => handleManualTime(ctx, state, text) },
  { state: 'awaitingUpdateEdit', handler: (ctx, state, text) => handleUpdateEditText(ctx, state, text) },
  { state: 'awaitingManualMileage', handler: (ctx, state, text) => handleManualMileageInput(ctx, state, text) },

  // 3) Кнопки главного меню
  { button: BUTTONS.punchTime, legacy: ['Время смены', 'Внести время смены', '⏱ Время'], handler: (ctx) => punchTimeFlow(ctx) },
  { button: BUTTONS.mileage, legacy: ['Внести пробег', '🚗 Пробег'], handler: (ctx) => mileageFlow(ctx) },
  { button: BUTTONS.routeSheet, legacy: ['Маршрутный лист', '📄 Маршрутник'], handler: (ctx) => routeSheetFlow(ctx) },
  { button: BUTTONS.reconciliation, legacy: ['Сверки', '📊 Сверки'], handler: (ctx) => reconciliationFlow(ctx) },
  { button: BUTTONS.cashCheck, legacy: ['Деньги к сдаче', '💵 Наличные'], handler: (ctx) => showPendingCashStatus(ctx) },
  { button: BUTTONS.issues, legacy: ['Проблема с заказом', '⚠️ Проблема'], handler: (ctx) => showIssuesMenu(ctx) },
  { button: BUTTONS.leaderBoard, legacy: ['Лидерборд', '🏆 Лидерборд'], handler: (ctx) => showLeaderboardMenu(ctx) },
  { button: BUTTONS.cashCollect, handler: (ctx) => showDebtorsList(ctx) },

  // 4) Меню настроек
  { button: BUTTONS.settings, legacy: ['Настройки'], handler: async (ctx, s, text, id) => ctx.replyWithHTML('⚙️ <b>Настройки</b>', settingsMenu(id)) },
  { button: BUTTONS.profile, legacy: ['Профиль'], handler: async (ctx, s, text, id) => ctx.replyWithHTML('✏️ <b>Профиль</b>', getProfileMenuForRole(ctx.from.id)) },
  { button: BUTTONS.help, legacy: ['Помощь'], handler: (ctx) => sendHelp(ctx) },

  // 5) Профиль (требуют ФИО)
  { button: BUTTONS.changeCar, legacy: ['Изменить номер машины', 'Номер машины'], handler: async (ctx) => {
    if (isLogist(ctx.from.id)) {
      await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
      return;
    }
    const fio = await requireFio(ctx);
    if (fio) await askForCarNumber(ctx, fio);
  }},
  { button: BUTTONS.changeWorkplace, legacy: ['Изменить интернет-магазин', 'Поменять магазин', 'Магазин'], handler: async (ctx) => {
    const fio = await requireFio(ctx);
    if (fio) await askForWorkplace(ctx, fio);
  }},
  { button: BUTTONS.changeDevice, legacy: ['Изменить устройство', 'Устройство'], handler: async (ctx) => {
    if (isLogist(ctx.from.id)) {
      await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
      return;
    }
    const fio = await requireFio(ctx);
    if (fio) await askForDevice(ctx, fio);
  }},
  { button: BUTTONS.switchUser, legacy: ['Поменять сотрудника', 'Сменить сотрудника', 'Сотрудник'], handler: handleSwitchUser },

  // 6) Настройки (Таблицы, Мой ID, История сборов)
  { button: BUTTONS.sheetInfo, legacy: ['Таблицы'], handler: handleSheetsInfo },
  { button: BUTTONS.myId, legacy: ['Мой ID'], handler: handleMyId },
  { button: BUTTONS.cashHistory, handler: (ctx) => showCashHistory(ctx) }
];

function matchTextRoute(route, text, state) {
  if (typeof route.match === 'function' && route.match(text, state)) return true;
  if (route.state && state?.[route.state]) return true;
  if (route.button) {
    if (text === route.button) return true;
    if (Array.isArray(route.legacy) && route.legacy.includes(text)) return true;
  }
  return false;
}

bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text.trim();
  const state = getState(telegramId);

  for (const route of TEXT_ROUTES) {
    if (matchTextRoute(route, text, state)) {
      return route.handler(ctx, state, text, telegramId);
    }
  }

  // Fallback: текст не подошёл ни под одну ветку
  await ctx.replyWithHTML('Выберите действие в меню или используйте /help.', getMenuForRole(telegramId));
});

bot.catch((error, ctx) => {
  console.error('bot error', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('uncaught exception:', error);
  shutdown('uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason);
  shutdown('unhandledRejection');
  process.exit(1);
});

const LAUNCH_RETRIES = LIMITS.LAUNCH_RETRIES;
const LAUNCH_BASE_DELAY = LIMITS.LAUNCH_BASE_DELAY_MS;
const LAUNCH_MAX_DELAY = LIMITS.LAUNCH_MAX_DELAY_MS;

// Глобальные таймеры — храним, чтобы при ретрае не плодить дубликаты
let _backupInitialTimer = null;
let _backupIntervalTimer = null;

async function setupBotCommands() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Начать работу' },
      { command: 'help', description: 'Помощь' },
      { command: 'car', description: 'Изменить номер машины' },
      { command: 'workplace', description: 'Изменить магазин' },
      { command: 'device', description: 'Изменить устройство' },
      { command: 'cancel', description: 'Отмена' },
      { command: 'role', description: 'Сменить роль (админ)' }
    ], { scope: { type: 'all_private_chats' } });
  } catch (e) {
    console.error('setMyCommands private error', e.message);
  }

  // Чистим команды для групп/админов/дефолта (бот предназначен только для приватов)
  await Promise.all([
    bot.telegram.deleteMyCommands({ scope: { type: 'all_group_chats' } })
      .catch((e) => console.error('deleteMyCommands group error', e.message)),
    bot.telegram.deleteMyCommands({ scope: { type: 'all_chat_administrators' } })
      .catch((e) => console.error('deleteMyCommands admins error', e.message)),
    bot.telegram.deleteMyCommands()
      .catch((e) => console.error('deleteMyCommands default error', e.message))
  ]);
}

async function startBot(retry = 0) {
  try {
    const { version, changed, changedFiles } = checkVersion();
    initGoogleSheets();
    const removedMonths = cleanupOldMonths();
    if (removedMonths > 0) {
      console.log(`cleaned up ${removedMonths} old month(s) from storage`);
    }

    // ВАЖНО: в Telegraf 4 у bot.launch() нет коллбэка после старта — он
    // принимает options-объект. Раньше код внутри () => {...} никогда не
    // выполнялся, поэтому на проде не было setMyCommands и авто-бэкапов.
    // Теперь всё это вынесено наружу.

    // Команды Telegram и стикерпаки — fire-and-forget до launch
    setupBotCommands().catch((e) => console.error('setupBotCommands fatal', e.message));
    importConfiguredFunStickerSets({ telegram: bot.telegram }).catch((error) => {
      console.error('fun sticker import fatal', error.message || error);
    });

    // Бэкапы — только при первом запуске, чтобы ретраи не плодили таймеры
    if (retry === 0) {
      if (_backupInitialTimer) clearTimeout(_backupInitialTimer);
      if (_backupIntervalTimer) clearInterval(_backupIntervalTimer);
      _backupInitialTimer = setTimeout(() => {
        runBackupCycle().catch((e) => console.error('initial backup error', e.message));
      }, 5000);
      _backupIntervalTimer = setInterval(() => {
        runBackupCycle().catch((e) => console.error('backup cycle error', e.message));
      }, BACKUP_INTERVAL_MS);
      _backupInitialTimer.unref?.();
      _backupIntervalTimer.unref?.();
    }

    // Уведомление админам об обновлении — только при changed && первом запуске
    if (changed && retry === 0) {
      setTimeout(() => {
        askAdminsAboutUpdate(version, changedFiles).catch((error) => {
          console.error('admin update ask fatal', error.message || error);
        });
      }, 3000);
    }

    // bot.launch() возвращает Promise, который резолвится только при stop().
    // НЕ ставим await — иначе всё, что после, не выполнится.
    bot.launch();
    console.log(`bot started v${version}${changed ? ' (updated)' : ''}`);
  } catch (error) {
    const delay = Math.min(LAUNCH_BASE_DELAY * Math.pow(2, retry), LAUNCH_MAX_DELAY);
    console.error(`bot launch error (attempt ${retry + 1}/${LAUNCH_RETRIES}):`, error?.message || error);
    if (retry < LAUNCH_RETRIES) {
      console.error(`retrying in ${delay / 1000}s ...`);
      setTimeout(() => startBot(retry + 1), delay);
    } else {
      console.error('max launch retries reached, exiting');
      process.exit(1);
    }
  }
}

startBot();

let _shutdownInProgress = false;

function flushAllSync() {
  try { flushStateNow(); } catch (e) { console.error('flushStateNow failed', e.message); }
  try { flushStorageNow(); } catch (e) { console.error('flushStorageNow failed', e.message); }
  try { flushFunReactionsNow(); } catch (e) { console.error('flushFunReactionsNow failed', e.message); }
  try { flushLeaderboardNow(); } catch (e) { console.error('flushLeaderboardNow failed', e.message); }
}

function shutdown(signal) {
  // Защита от повторного входа: pm2 / systemd иногда шлют сигнал дважды.
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;

  console.log(`shutdown initiated by ${signal}`);
  flushAllSync();

  try {
    makeBackupSync('pre-shutdown');
  } catch (e) {
    console.error('pre-shutdown backup failed', e.message);
  }

  try {
    bot.stop(signal);
  } catch (e) {
    console.error('bot.stop failed', e.message);
  }
}

function makeBackupSync(reason = 'auto') {
  const now = new Date();
  const ts = now.toISOString().replace(/[.:]/g, '-');
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  for (const filename of BACKUP_FILES) {
    const src = path.join(__dirname, filename);
    const dst = path.join(BACKUP_DIR, `${filename.replace('.json', '')}-${reason}-${ts}.json`);
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    } catch (_) {}
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
// SIGUSR2 — pm2 graceful reload и nodemon restart. Без этого хука перезапуски
// в dev/staging могли терять in-memory state и недозаписанные данные.
process.once('SIGUSR2', () => shutdown('SIGUSR2'));
// beforeExit — последний шанс сохранить данные при штатном выходе.
process.on('beforeExit', () => {
  if (_shutdownInProgress) return;
  flushAllSync();
});
