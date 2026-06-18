require('dotenv').config();
require('./logger').initLogger();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');

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
  updateCell,
  flushSheetUpdates,
  getSheetConfig,
  updateEfficiencyOrders,
  loadPendingUpdatesFromDb,
  setNotifyAdminCallback
} = require('./services/googleSheets');
const {
  getUserField,
  getFullProfile,
  setUserField,
  getUserRole,
  deleteUser,
  getPendingCash,
  setPendingCash,
  setCashConfirmationStatus,
  clearPendingCashAndReminders,
  getAllUserIds,
  resolveSheetInfo,
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
  getSelfClearanceRequest,
  cleanupStaleReminders,
  getShiftStatus,
  setShiftStatus,
  clearShiftStatus
} = require('./services/storage');
const { recognizeMileage, downloadTelegramFile, isGeminiOcrEnabled, recognizeTextWithGemini, getMinMileageThreshold, checkGeminiOcrHealth } = require('./services/mileageOcr');
const { saveOcrDebugImage, updateOcrDebugStatus } = require('./services/ocrDebug');
const {
  getReconciliationOcrTimeoutMs,
  roundMoney,
  emptyReconciliationCash,
  recognizeReconciliationCashSafe,
  shouldWarnAboutReconciliationOcr
} = require('./services/reconciliationOcr');
const { getCurrentDateInfo, getColumnLetter, getMileageColumnsByDay, getCourierColumnsByDay, roundMinutesToHalfHour, roundTimeToHalfHour, isEmptyCell, isScheduleMarker, withTimeout } = require('./utils');
const { registerSheetCommand } = require('./sheetCommand');
const { WORKPLACES, DEVICES, ROLES, LIMITS, WORKPLACE_FEATURES, WORKPLACE_KEY_MAP, BUTTONS } = require('./config');
const { isAdminUser, getAdminIds } = require('./services/auth');
const setupCommands = require('./handlers/commands');
const setupAdmin = require('./handlers/admin');
const setupTextRouter = require('./handlers/textRouter');
const setupCourier = require('./handlers/courier');
const setupLogist = require('./handlers/logist');
const setupReplyForwarding = require('./handlers/replyForwarding');
const {
  workplaceMenu,
  deviceMenu,
  logistMainMenu,
  getMenuForRole,
  getSettingsMenuForRole,
  getProfileMenuForRole,
  getTimeButtonLabel,
  getMileageButtonLabel,
  isTimeButton,
  isMileageButton,
  roleChoiceKeyboard,
  skipMileageKeyboard,
  mileageConfirmKeyboard,
  mileageSavedKeyboard,
  routeSheetKeyboard,
  manualMileageKeyboard,
  replaceKeyboard,
  timeChangeKeyboard,
  mileageReplaceKeyboard,
  switchUserKeyboard,
  cashSubmitConfirmKeyboard,
  debtorListKeyboard,
  courierMainMenu
} = require('./menus/keyboards');

const db = require('./db');
const { checkpoint, saveThread, findThreadByGroupMessage, findThreadById, saveForwardedMessage, findForwardedMessage, cleanupOldThreads } = require('./db');

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
  const dirs = [
    _sourceDir,
    path.join(_sourceDir, 'services'),
    path.join(_sourceDir, 'handlers'),
    path.join(_sourceDir, 'menus')
  ];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const dirFiles = fs.readdirSync(dir)
      .filter(f => f.endsWith('.js') && f !== 'version.js')
      .map(f => path.relative(_sourceDir, path.join(dir, f)));
    files.push(...dirFiles);
  }
  return files.sort();
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

function _getCurrentGitHash() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: __dirname }).trim();
  } catch {
    return null;
  }
}

const _EN_TO_RU = {
  'gemini': 'Gemini', 'prompt': 'промт', 'remove': 'удалён', 'switch': 'замена',
  'fix': 'исправление', 'add': 'добавлено', 'better': 'улучшен', 'single': 'только число',
  'odometer': 'одометр', 'mileage': 'пробег', 'ocr': 'OCR', 'text': 'текст',
  'fallback': 'запасной вариант', 'model': 'модель', 'available': 'доступна',
  'deprecated': 'устарела', 'numpy': 'numpy', 'import': 'импорт',
  'config': 'настройки', 'ecosystem': 'конфиг', 'server': 'сервер',
  'reader': 'чтение', 'env': 'окружение', 'key': 'ключ', 'api': 'API',
  'flash': 'Flash', 'lite': 'Lite', 'photo': 'фото', 'image': 'изображение',
  'dashboard': 'панель приборов', 'car': 'автомобиля', 'number': 'номер',
  'ignore': 'игнорируется', 'time': 'время', 'temperature': 'температура',
  'fuel': 'топливо', 'speed': 'скорость', 'rpm': 'RPM', 'trip': 'поездка',
  'reply': 'ответ', 'only': 'только', 'analyze': 'анализ', 'find': 'поиск',
  'total': 'общий',
  'initialize': 'загрузка',
  'support': 'поддержка', 'configured': 'настроен', 'version': 'версия',
  'startup': 'запуск', 'health': 'проверка', 'endpoint': 'эндпоинт',
  'sheet': 'таблица', 'log': 'лог', 'change': 'изменение', 'update': 'обновление',
  'clean': 'очистка', 'old': 'старый', 'new': 'новый', 'code': 'код',
  'file': 'файл', 'function': 'функция', 'variable': 'переменная',
  'error': 'ошибка', 'handle': 'обработка', 'result': 'результат',
  'recognize': 'распознавание', 'recognize_text': 'распознавание текста',
  'extract': 'извлечение', 'detect': 'обнаружение', 'check': 'проверка',
  'validate': 'валидация', 'save': 'сохранение', 'load': 'загрузка',
  'process': 'обработка', 'background': 'фоновая', 'async': 'асинхронно',
};

const COMMIT_PREFIX_RU = {
  feat: '✨ Добавлено',
  fix: '🔧 Исправлено',
  refactor: '♻️ Переработано',
  chore: '🔧 Техническое',
  docs: '📝 Документация',
  style: '🎨 Оформление',
  perf: '⚡ Оптимизация',
  test: '🧪 Тесты',
  build: '📦 Сборка',
  ci: '⚙️ CI/CD',
  revert: '↩️ Откат'
};

function _translateToRussian(text) {
  let result = text;
  for (const [en, ru] of Object.entries(_EN_TO_RU)) {
    const regex = new RegExp(`\\b${en}\\b`, 'gi');
    result = result.replace(regex, ru);
  }
  result = result.replace(/\b(\d+)\s*-\s*(\w)/g, (m, d, w) => `${d} — ${w.toLowerCase()}`);
  return result;
}

function _getGitLogSince(fromHash) {
  if (!fromHash) return null;
  try {
    const log = execSync(`git log --oneline --no-merges ${fromHash}..HEAD`, { encoding: 'utf8', cwd: __dirname });
    return log.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        let msg = line.replace(/^[0-9a-f]+\s+/, '');
        const prefixMatch = msg.match(/^(feat|fix|refactor|chore|docs|style|perf|test|build|ci|revert):\s*/i);
        if (prefixMatch) {
          const prefix = prefixMatch[1].toLowerCase();
          const ruPrefix = COMMIT_PREFIX_RU[prefix] || prefix;
          msg = msg.slice(prefixMatch[0].length);
          msg = _translateToRussian(msg);
          msg = msg.charAt(0).toUpperCase() + msg.slice(1);
          return `${ruPrefix}: ${msg}`;
        }
        if (msg.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u)) {
          return msg.charAt(0).toUpperCase() + msg.slice(1);
        }
        msg = _translateToRussian(msg);
        msg = msg.charAt(0).toUpperCase() + msg.slice(1);
        return msg;
      })
      .filter(msg => msg.length > 0);
  } catch {
    return null;
  }
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
    const gitHash = _getCurrentGitHash();
    const data = {
      version: initialVersion,
      lastHash: currentHash,
      files: currentFiles,
      updatedAt: new Date().toISOString(),
      gitHash: gitHash || undefined,
      updates: []
    };
    fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf8');
    return {
      version: initialVersion,
      changed: true,
      prevVersion: null,
      changedFiles: Object.keys(currentFiles).sort(),
      updates: []
    };
  }
  if (stored.lastHash === currentHash) {
    return { version: stored.version, changed: false, prevVersion: null, changedFiles: [], updates: stored.updates || [] };
  }
  const changedFiles = _getChangedFiles(stored.files, currentFiles);
  const bumpType = getChangelogBump();
  const newVersion = _bumpVersion(stored.version, bumpType);
  let updates = _getGitLogSince(stored.gitHash);
  if (!updates || updates.length === 0) {
    updates = null;
  }
  const gitHash = _getCurrentGitHash();
  const data = {
    version: newVersion,
    lastHash: currentHash,
    files: currentFiles,
    updatedAt: new Date().toISOString(),
    gitHash: gitHash || undefined,
    updates: updates || []
  };
  fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`version bumped: ${stored.version} → ${newVersion} (${bumpType})`);
  return { version: newVersion, changed: true, prevVersion: stored.version, changedFiles, updates: updates || [] };
}

function getVersion() {
  const stored = _getCurrentVersion();
  return stored ? stored.version : '2.0.0';
}



// WORKPLACES, DEVICES — теперь из config.js (см. импорт выше)

function isLogist(telegramId) {
  return getUserRole(telegramId) === 'logist';
}

async function showDebtorsList(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== 'logist') {
    return { status: 'access_denied' };
  }

  const workplace = getUserField(telegramId, 'workplace');
  if (!workplace) {
    return { status: 'no_workplace' };
  }

  const features = WORKPLACE_FEATURES[workplace];
  if (!features || !features.cashCollection) {
    return { status: 'no_cash_collection' };
  }

  cleanupStaleReminders();

  const debtors = getDebtors(workplace);

  if (debtors.length === 0) {
    return { status: 'no_debt' };
  }

  const totalAmount = debtors.reduce((sum, d) => sum + d.amount, 0);
  const formattedTotal = formatMoneyRu(totalAmount);

  await ctx.replyWithHTML(
    `💳 <b>Курьеры с долгами</b> (${esc(workplace)})\n` +
    `Всего к сдаче: <code>${formattedTotal}</code> ₽\n\n` +
    debtors.map((d) => `• ${esc(d.fio)} — <code>${formatMoneyRu(d.amount)}</code> ₽`).join('\n'),
    debtorListKeyboard(debtors, workplace)
  );
  return { status: 'showing_debtors' };
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

  const pendingCash = getPendingCash(courierId);
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

  const workplaceLabel = courierRecord.workplace || 'не указано';
  const courierMsg = `🔔 <b>Логист ${esc(logistFio)} напоминает:</b>\n\n` +
    `💵 У вас <code>${esc(formatted)}</code> ₽ к сдаче.\n` +
    `🏬 <b>${esc(workplaceLabel)}</b>\n\n` +
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

async function showHistoryDatePicker(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== 'logist') {
    return { status: 'access_denied' };
  }

  const workplace = getUserField(telegramId, 'workplace');
  const features = WORKPLACE_FEATURES[workplace];
  if (!features || !features.cashCollection) {
    return { status: 'no_cash_collection' };
  }

  const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
  const buttons = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: timezone });
    const dayLabel = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone });
    const prefix = i === 0 ? '📅 ' : '';
    buttons.push([Markup.button.callback(`${prefix}${dayLabel}`, `ch_${dateStr}`)]);
  }
  buttons.push([Markup.button.callback('❌ Закрыть', 'close_message')]);

  await ctx.replyWithHTML('📋 <b>История сборов</b>\n\nВыберите дату:', Markup.inlineKeyboard(buttons));
  return { status: 'showing_history' };
}

async function showCashHistoryForDate(ctx, dateStr) {
  const telegramId = ctx.from.id;
  const workplace = getUserField(telegramId, 'workplace');
  const rows = getCashHistory(dateStr, workplace);

  const approvedRows = rows.filter(r => r.action === 'approved' || r.action === 'self_cleared' || r.action === 'logist_approved');

  if (approvedRows.length === 0) {
    await ctx.replyWithHTML(`📋 <b>История сборов за ${dateStr}</b>\n\nНет подтверждённых сдач за эту дату.`);
    return;
  }

  const total = approvedRows.reduce((sum, r) => sum + r.amount, 0);
  let msg = `📋 <b>История сборов за ${dateStr}</b>\n` +
    `Всего собрано: <code>${formatMoneyRu(total)}</code> ₽\n\n`;

  for (const row of approvedRows) {
    let icon = '✅';
    if (row.action === 'self_cleared') icon = '💵';
    else if (row.action === 'logist_approved') icon = '👍';
    let logistLabel;
    if (row.action === 'self_cleared') {
      logistLabel = ' (самостоятельно)';
    } else if (row.action === 'logist_approved') {
      logistLabel = row.logistFio ? ` (логист: ${esc(row.logistFio)})` : ' (логист)';
    } else {
      logistLabel = row.logistFio ? ` (логист: ${esc(row.logistFio)})` : '';
    }
    msg += `${icon} ${esc(row.courierFio)} — <code>${formatMoneyRu(row.amount)}</code> ₽${logistLabel}\n`;
  }

  await ctx.replyWithHTML(msg);
}

async function openShopNotify(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== 'logist') {
    return { status: 'access_denied' };
  }

  const workplace = getUserField(telegramId, 'workplace');
  if (!workplace) {
    return { status: 'no_workplace' };
  }

  const fio = getUserField(telegramId, 'fio') || 'Логист';
  const chatId = process.env.SHOP_STATUS_CHAT_ID;
  if (chatId) {
    try {
      await bot.telegram.sendMessage(chatId,
        `🏪 <b>${esc(workplace)} — ОТКРЫТ</b> ✅\n\nЛогист: ${esc(fio)}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('shop open notify error', e.message || e);
    }
  }

  return { status: 'ok', workplace };
}

async function notifyLogistsAboutSelfClearance(courierId, courierFio, amount, formatted, workplace) {
  const logists = findLogistsForWorkplace(workplace);

  const allRecipientIds = new Set();
  for (const logist of logists) {
    allRecipientIds.add(String(logist.telegramId));
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
        { parse_mode: 'HTML', ...keyboard }
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

// Middleware: замер времени обработки запросов
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (ms > 500) {
    const updateType = ctx.updateType || 'unknown';
    const text = ctx.message?.text || ctx.callbackQuery?.data || '';
    console.log(`⚠️ Медленный запрос: ${ms}мс, тип: ${updateType}, от: ${ctx.from?.id}, текст/данные: ${text}`);
  }
});

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

function getTimeGreeting(timezone = process.env.APP_TIMEZONE || 'Europe/Moscow') {
  const hour = parseInt(new Date().toLocaleString('en-GB', { timeZone: timezone, hour: 'numeric', hour12: false }));
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
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

function buildPhotoCaption(state, telegramId) {
  const name = getEmployeeDisplayName(state.fio);
  const nameLine = telegramId
    ? `👤 <a href="tg://user?id=${telegramId}">${esc(name)}</a>`
    : `👤 ${name}`;
  return truncateCaption([
    formatPhotoStatus(state.stage),
    nameLine,
    `🚙 ${state.auto || 'не указано'}`,
    `🏬 ${state.workplace || 'не указано'}`
  ].join('\n'));
}

function buildRouteSheetCaption(state, routeSheetNumber, telegramId) {
  const name = getEmployeeDisplayName(state.fio);
  const nameLine = telegramId
    ? `👤 <a href="tg://user?id=${telegramId}">${esc(name)}</a>`
    : `👤 ${name}`;
  return truncateCaption([
    `📄 Маршрутный лист №${routeSheetNumber}`,
    nameLine,
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
  try {
    checkpoint();
  } catch (_) {}
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
  try {
    checkpoint();
  } catch (_) {}
  await makeBackup('auto');
  await cleanOldBackups();
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
    if (ctx.message?.text?.startsWith('/chatid')) {
      return next();
    }
    return next(); // Allow group messages to pass through to other handlers
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

const MAX_REASONABLE_CASH_AMOUNT = 500000;

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
    BUTTONS.punchTimeStart,
    BUTTONS.punchTimeEnd,
    BUTTONS.punchTimeReplace,
    BUTTONS.mileage,
    BUTTONS.mileageStart,
    BUTTONS.mileageEnd,
    BUTTONS.mileageReplace,
    BUTTONS.routeSheet,
    BUTTONS.reconciliation,
    BUTTONS.cashCheck,
    BUTTONS.issues,
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

  ].includes(text) || WORKPLACES.includes(text) || DEVICES.includes(text);
}

async function askForCarNumber(ctx, fio = getUserField(ctx.from.id, 'fio')) {
  setState(ctx.from.id, { awaitingCarNumber: true, fio });
  await ctx.replyWithHTML(
    `🚗 <b>Номер машины</b>\n\nВведите гос. номер автомобиля.\nНапример: <code>А123ВС777</code>`,
    Markup.removeKeyboard()
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
    return 'error';
  }

  if (!isValidCarNumber(carNumber)) {
    await ctx.replyWithHTML('❌ Неверный формат номера.\nНомер должен содержать буквы и цифры.\nНапример: <code>А123ВС777</code>');
    return 'error';
  }

  setUserField(ctx.from.id, 'carNumber', carNumber);
  console.log('номер машины сохранён');

  if (!getUserField(ctx.from.id, 'workplace')) {
    await ctx.replyWithHTML(`✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`);
    await askForWorkplace(ctx);
    return 'askWorkplace';
  }

  if (!getUserField(ctx.from.id, 'device')) {
    await ctx.replyWithHTML(`✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`);
    await askForDevice(ctx);
    return 'askDevice';
  }

  clearState(ctx.from.id);
  await ctx.replyWithHTML(`✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`);
  return 'done';
}

async function saveWorkplace(ctx, value) {
  const workplace = WORKPLACES.find((item) => item.toLowerCase() === String(value || '').trim().toLowerCase());

  if (!workplace) {
    await ctx.replyWithHTML('❌ Выберите магазин кнопкой ниже.', workplaceMenu());
    return 'error';
  }

  setUserField(ctx.from.id, 'workplace', workplace);
  console.log('интернет-магазин сохранён');
  const role = getUserRole(ctx.from.id);

  if (role === 'logist') {
    clearState(ctx.from.id);
    await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`);
    return 'done';
  }

  if (!getUserField(ctx.from.id, 'device')) {
    await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`);
    await askForDevice(ctx);
    return 'askDevice';
  }

  clearState(ctx.from.id);
  await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`);
  return 'done';
}

async function saveDevice(ctx, value) {
  const device = DEVICES.find((item) => item.toLowerCase() === String(value || '').trim().toLowerCase());

  if (!device) {
    await ctx.replyWithHTML('❌ Выберите устройство кнопкой ниже.', deviceMenu());
    return 'error';
  }

  setUserField(ctx.from.id, 'device', device);
  clearState(ctx.from.id);
  console.log('устройство сохранено');
  await ctx.replyWithHTML(`✅ Устройство сохранено: <b>${esc(device)}</b>`);
  return 'done';
}

async function ensureProfile(ctx) {
  const profile = getFullProfile(ctx.from.id);
  const role = getUserRole(ctx.from.id);

  if (!profile.fio) {
    await askForFio(ctx);
    return null;
  }

  if (role !== 'logist') {
    if (profile.courierType !== 'pedestrian' && !profile.carNumber) {
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

    const auto = String(employee.auto || '').trim().toLowerCase();
    const workplace = employee.workplace;

    if (workplace === 'ИМ Центр') {
      if (auto === 'пеший') {
        setUserField(telegramId, 'courierType', 'pedestrian');
        setUserField(telegramId, 'role', 'courier');
        setUserField(telegramId, 'workplace', 'ИМ Центр');
        await ctx.replyWithHTML('🚶 <b>Пеший курьер</b>, магазин <b>ИМ Центр</b>.');
        await askForDevice(ctx, employee.fio);
        return;
      }
      if (auto === 'логист') {
        setUserField(telegramId, 'role', 'logist');
        await ctx.replyWithHTML('📦 <b>Логист</b>.\n\nТеперь выберите ваш магазин.', logistMainMenu(telegramId));
        await askForWorkplace(ctx, employee.fio);
        return;
      }
      setUserField(telegramId, 'courierType', 'auto');
      setUserField(telegramId, 'role', 'courier');
      await ctx.replyWithHTML('🚗 <b>Авто-курьер</b>.\n\nТеперь введите номер машины.');
      await askForCarNumber(ctx, employee.fio);
      return;
    }

    if (workplace === 'ИМ Восток') {
      if (auto === 'логист') {
        setUserField(telegramId, 'role', 'logist');
        await ctx.replyWithHTML('📦 <b>Логист</b>.\n\nТеперь выберите ваш магазин.', logistMainMenu(telegramId));
        await askForWorkplace(ctx, employee.fio);
        return;
      }
      setState(telegramId, { awaitingRoleChoice: true, fio: employee.fio, workplace: employee.workplace });
      await ctx.replyWithHTML(
        '👤 <b>Выберите вашу роль:</b>\n\n' +
        '▫️ <b>Курьер</b> — доставка заказов, пробег, маршрутник, сверка, наличные\n' +
        '▫️ <b>Логист</b> — учёт времени, сбор наличных с курьеров, таблицы',
        roleChoiceKeyboard()
      );
      return;
    }

    setState(telegramId, { awaitingRoleChoice: true, fio: employee.fio, workplace: employee.workplace });
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
    const isPedestrian = profile.courierType === 'pedestrian';
    const result = explicitStage
      ? await replaceTime(profile.fio, profile.workplace, explicitStage, isPedestrian)
      : await punchTime(profile.fio, profile.workplace, isPedestrian);

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
    const currentTimeStatus = getShiftStatus(telegramId, 'time');
    if (result.stage === 'start') {
      setShiftStatus(telegramId, 'time', currentTimeStatus === 'end' || currentTimeStatus === 'both' ? 'both' : 'start');
    } else {
      setShiftStatus(telegramId, 'time', currentTimeStatus === 'start' || currentTimeStatus === 'both' ? 'both' : 'end');
    }

    if (result.stage === 'start') {
      const cur = Number(getUserField(telegramId, 'shiftCount') || 0);
      setUserField(telegramId, 'shiftCount', cur + 1);
    }

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
    await ctx.replyWithHTML('✅', getMenuForRole(telegramId));

    if (result.stage === 'start') {
      const pendingCash = getPendingCash(telegramId);
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
    return { status: 'access_denied' };
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: 'no_profile' };
  }

  if (profile.courierType === 'pedestrian') {
    return { status: 'pedestrian_no_mileage' };
  }

  try {
    const result = await prepareMileage(profile.fio, profile.workplace, explicitStage);

    if (result.notFound) {
      return { status: 'not_found', result, workplace: profile.workplace };
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
      return { status: 'needs_replace_choice' };
    }

    setState(telegramId, makeMileageState(telegramId, applyProfile(result, profile), { source: 'mileage' }));
    console.log('ожидание пробега', result.stage);
    await ctx.replyWithHTML(
      `📷 <b>Отправьте фото одометра</b>\n\n` +
      `Этап: <b>${esc(formatStage(result.stage))}</b>\n\n` +
      `📎 <i>Нажмите на скрепку → Камера или Галерея</i>`,
      skipMileageKeyboard()
    );
    return { status: 'awaiting_photo' };
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    return { status: 'error' };
  }
}

async function routeSheetFlow(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: 'access_denied' };
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: 'no_profile' };
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
  return { status: 'awaiting_photo' };
}

async function reconciliationFlow(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: 'access_denied' };
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: 'no_profile' };
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
  return { status: 'awaiting_photo' };
}

async function showPendingCashStatus(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: 'access_denied' };
  }
  const profile = await ensureProfile(ctx);
  if (!profile) return { status: 'no_profile' };

  const pendingCash = getPendingCash(ctx.from.id);
  const amount = Number(pendingCash?.amount || 0);

  if (!Number.isFinite(amount) || amount < 1) {
    return { status: 'no_debt' };
  }

  if (pendingCash?.confirmationStatus === 'awaiting') {
    return { status: 'already_submitted' };
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
  return { status: 'showing_pending' };
}

async function sendHelp(ctx) {
  const role = getUserRole(ctx.from.id);

  if (role === 'logist') {
    const workplace = getUserField(ctx.from.id, 'workplace');
    const features = WORKPLACE_FEATURES[workplace] || {};
    const hasCash = features.cashCollection;
    let logistHelp = '❓ <b>Помощь</b>\n' +
      '━━━━━━━━━━━━━━━\n\n' +
      `1️⃣ <b>Записать время</b> — «${BUTTONS.punchTime}» отметить начало или конец смены.\n` +
      `2️⃣ <b>Открыть ИМ</b> — «${BUTTONS.openShop}» отправить уведомление об открытии магазина в группу.\n`;
    if (hasCash) {
      logistHelp += `3️⃣ <b>Принять наличные</b> — «${BUTTONS.cashCollect}» посмотреть должников и отправить напоминание.\n`;
      logistHelp += `4️⃣ <b>История сборов</b> — «${BUTTONS.cashHistory}» просмотр истории по датам.\n`;
    }
    logistHelp += `${hasCash ? '5️⃣' : '3️⃣'} <b>Таблицы</b> — «${BUTTONS.sheetInfo}» информация о привязке таблиц.\n`;
    logistHelp += `${hasCash ? '6️⃣' : '4️⃣'} <b>Настройки</b> — «${BUTTONS.settings}» магазин, смена сотрудника.\n\n`;
    logistHelp += '📋 Команды:';
    await ctx.replyWithHTML(
      logistHelp,
      Markup.inlineKeyboard([
        [Markup.button.callback('📋 Команды', 'help_commands')],
        [Markup.button.callback('❌ Закрыть', 'close_message')]
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
    `8️⃣ <b>Настройки</b> — «${BUTTONS.settings}» номер машины, магазин, устройство, сотрудник.\n\n` +
    '📋 Команды:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📋 Команды', 'help_commands')],
      [Markup.button.callback('❌ Закрыть', 'close_message')]
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

function buildUpdateHighlights(changedFiles = [], version, updates = []) {
  const files = new Set((changedFiles || []).map((file) => String(file || '').toLowerCase()));
  const includesAny = (targets) => targets.some((target) => files.has(target.toLowerCase()));
  const highlights = [];

  if (includesAny(['gemini_ocr_server.py'])) {
    highlights.push('📸 Полностью обновлён движок OCR: Gemini 2.5 Flash Lite распознаёт и пробег, и сверки.');
  }

  if (includesAny(['bot.js'])) {
    highlights.push('🤖 Обновлена логика бота, улучшена стабильность.');
  }

  if (includesAny(['ecosystem.config.js'])) {
    highlights.push('⚙️ Обновлены настройки запуска.');
  }

  if (includesAny(['sheetcommand.js', 'googlesheets.js', 'storage.js'])) {
    highlights.push('🗂 Улучшена работа с таблицами.');
  }

  if (includesAny(['mileageocr.js'])) {
    highlights.push('📸 Улучшено распознавание пробега.');
  }

  if (includesAny(['achievements.js', 'xp.js', 'challenges.js', 'streak.js'])) {
    highlights.push('🏆 Обновлена система достижений и рейтинга.');
  }

  if (includesAny(['courier.js', 'logist.js', 'commands.js', 'admin.js', 'textrouter.js', 'replyforwarding.js'])) {
    highlights.push('💬 Обновлены сценарии общения с ботом.');
  }

  if (includesAny(['utils.js'])) {
    highlights.push('🧮 Обновлены вспомогательные функции.');
  }

  if (highlights.length === 0) {
    highlights.push('✨ Небольшие улучшения стабильности и удобства.');
  }

  // Добавляем 1-2 git-коммита как детали (если есть)
  if (Array.isArray(updates) && updates.length > 0) {
    const details = updates.slice(0, 3).map((u) => `• ${u}`);
    return { highlights: highlights.slice(0, 4), details };
  }

  return { highlights: highlights.slice(0, 4), details: [] };
}

function formatUpdateMessage(version, changedFiles = [], updates = []) {
  const { highlights, details } = buildUpdateHighlights(changedFiles, version, updates);
  const lines = highlights.map((item) => `• ${esc(item)}`).join('\n');

  let detailsBlock = '';
  if (details.length > 0) {
    detailsBlock = '\n\n<b>Подробности:</b>\n' + details.join('\n');
  }

  return (
    `🆕 <b><i>Обновление бота v${esc(version)}</i></b>\n\n` +
    '<b>Коротко, что изменили:</b>\n' +
    `${lines}${detailsBlock}\n\n` +
    '💙 Хорошей смены!'
  );
}

async function notifyUsersAboutUpdate(version, changedFiles = [], updates = []) {
  const currentVersion = version || getVersion();
  const userIds = getAllUserIds();
  let notified = 0;
  let skipped = 0;
  let failed = 0;

  const message = formatUpdateMessage(currentVersion, changedFiles, updates);

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
const PENDING_UPDATES_FILE = path.join(__dirname, 'pending_updates.json');

function loadPendingUpdates() {
  try {
    if (fs.existsSync(PENDING_UPDATES_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_UPDATES_FILE, 'utf8'));
      Object.assign(_pendingUpdates, data);
      console.log('loaded pending updates', Object.keys(data));
    }
  } catch (e) {
    console.error('failed to load pending updates', e.message);
  }
}

function savePendingUpdates() {
  try {
    fs.writeFileSync(PENDING_UPDATES_FILE, JSON.stringify(_pendingUpdates, null, 2));
  } catch (e) {
    console.error('failed to save pending updates', e.message);
  }
}

loadPendingUpdates();

async function askAdminsAboutUpdate(version, changedFiles = [], updates = []) {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    console.log('no admin IDs configured, skipping update approval');
    return;
  }

  const message = formatUpdateMessage(version, changedFiles, updates);
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

  _pendingUpdates[version] = { changedFiles, updates, message };
  savePendingUpdates();

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

async function saveMileageFromState(ctx, mileage, options = {}) {
  const { sourceBuffer, telegram, chatId, fallbackState } = options;
  const replyFn = telegram
    ? (html, extra) => telegram.sendMessage(chatId, html, { parse_mode: 'HTML', ...(extra || {}) })
    : (html, extra) => ctx.replyWithHTML(html, extra);

  const telegramId = ctx.from.id;
  let state = getState(telegramId);
  let mileageValue = parseMileageNumber(mileage);

  // Если состояние очищено (пользователь ушёл в меню) — используем fallback.
  // Если пользователь начал новое фото (fileId изменился) — не пишем старый результат.
  if (!state || !state.mileageRow || !state.day) {
    if (!fallbackState) {
      await replyFn('⚠️ Не удалось записать пробег.\nПопробуйте ещё раз или обратитесь к администратору.');
      return;
    }
    const live = getState(telegramId);
    if (live && live.fileId && live.fileId !== fallbackState.fileId) {
      console.log('mileage: user started new photo, skipping old save');
      return;
    }
    state = fallbackState;
  } else if (state.fileId && fallbackState && state.fileId !== fallbackState.fileId) {
    // Живое состояние есть, но fileId разный — пользователь начал новый пробег
    console.log('mileage: live state has different fileId, skipping old save');
    await replyFn('⚠️ <b>Пробег распознан, но вы начали новое действие.</b>\nЕсли нужно, отправьте фото повторно.', mileageConfirmKeyboard());
    return;
  }

  if (!state || !state.mileageRow || !state.day || !state.stage) {
    await replyFn('⚠️ Не удалось записать пробег.\nПопробуйте ещё раз или обратитесь к администратору.');
    return;
  }

  if (!mileageValue) {
    await replyFn('❌ Неверный пробег. Допустимы только 2-6 цифр.\nНапример: <code>25408</code>');
    return;
  }

  try {
    await updateMileage(state.mileageRow, state.day, state.stage, mileageValue, state.workplace);
    console.log('пробег записан');
    const currentMileageStatus = getShiftStatus(telegramId, 'mileage');
    if (state.stage === 'start') {
      setShiftStatus(telegramId, 'mileage', currentMileageStatus === 'end' || currentMileageStatus === 'both' ? 'both' : 'start');
    } else {
      setShiftStatus(telegramId, 'mileage', currentMileageStatus === 'start' || currentMileageStatus === 'both' ? 'both' : 'end');
    }
    const curMileage = Number(getUserField(telegramId, 'mileageRecords') || 0);
    setUserField(telegramId, 'mileageRecords', curMileage + 1);
    logOcrFeedback(telegramId, state.ocrValue || null, mileageValue, sourceBuffer, {
      stage: state.stage,
      workplace: state.workplace,
      fio: state.fio,
      fileId: state.fileId
    });
    setState(telegramId, {
      ...state,
      awaitingMileagePhoto: false,
      awaitingManualMileage: false,
      photoReceived: true,
      savedMileage: mileageValue,
      mileageProcessing: false
    });
    await replyFn(
      `✅ <b>Пробег сохранён</b>: <code>${mileageValue}</code> км\n\nЕсли неверно — нажмите «Изменить пробег».`,
      mileageSavedKeyboard()
    );
    await replyFn('✅', getMenuForRole(telegramId));
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await replyFn('⚠️ Не удалось записать пробег.\nПопробуйте ещё раз или обратитесь к администратору.');
  } finally {
    if (telegram) {
      const finalState = getState(telegramId);
      if (finalState) {
        setState(telegramId, { ...finalState, mileageProcessing: false });
      }
    }
  }
}

async function sendPhotoToChat(ctx, fileId, caption, { envChatId, envThreadId, parseMode, fallbackChatId } = {}) {
  let chatId = envChatId ? process.env[envChatId] : null;

  if (!chatId && fallbackChatId) {
    chatId = fallbackChatId;
  }

  if (!chatId) {
    console.log(`${envChatId || 'chatId'} is empty, photo is not forwarded`);
    return null;
  }

  const options = { caption };

  if (parseMode) {
    options.parse_mode = parseMode;
  }

  const threadId = envThreadId ? process.env[envThreadId] : null;
  if (threadId) {
    options.message_thread_id = Number(threadId);
  }

  // Clear any stale reply keyboard in group chats
  options.reply_markup = { remove_keyboard: true };

  try {
    const result = await ctx.telegram.sendPhoto(chatId, fileId, options);
    return result;
  } catch (error) {
    console.error('telegram sendPhoto error', error?.message || error);
    return null;
  }
}

async function sendMediaGroupToChat(ctx, items, { envChatId, envThreadId, parseMode, fallbackChatId } = {}) {
  let chatId = envChatId ? process.env[envChatId] : null;

  if (!chatId && fallbackChatId) {
    chatId = fallbackChatId;
  }

  if (!chatId) {
    console.log(`${envChatId || 'chatId'} is empty, media group is not forwarded`);
    return null;
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
    const result = await ctx.telegram.sendMediaGroup(chatId, media, options);

    // Clear any stale reply keyboard in group chats
    try {
      const cleanupMsg = await ctx.telegram.sendMessage(chatId, '', {
        reply_markup: { remove_keyboard: true },
        message_thread_id: threadId ? Number(threadId) : undefined
      });
      await ctx.telegram.deleteMessage(chatId, cleanupMsg.message_id).catch(() => {});
    } catch (_) {}

    return result;
  } catch (error) {
    console.error('telegram sendMediaGroup error', error?.message || error);
    return null;
  }
}

// Конфиг назначений фото — единая таблица. Если появится новый чат
// (например, для штрафов), добавить запись и одну функцию-обёртку.
const PHOTO_DESTINATIONS = {
  work: {
    envChatId: 'WORK_CHAT_ID',
    envThreadId: 'WORK_THREAD_ID',
    parseMode: 'HTML'
  },
  routeSheet: {
    envChatId: 'ROUTE_SHEET_CHAT_ID',
    envThreadId: 'ROUTE_SHEET_THREAD_ID',
    fallbackEnvChatId: 'WORK_CHAT_ID',
    parseMode: 'HTML'
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
    return Promise.resolve(null);
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
    return Promise.resolve(null);
  }
  return sendMediaGroupToChat(ctx, items, {
    envChatId: dest.envChatId,
    envThreadId: dest.envThreadId,
    parseMode: dest.parseMode,
    fallbackChatId: dest.fallbackEnvChatId ? process.env[dest.fallbackEnvChatId] : undefined
  });
}

function savePhotoThread(result, telegramId, type) {
  if (!result || !result.chat || !result.message_id || !telegramId) return;
  saveThread(result.chat.id, result.message_id, telegramId, type);
  cleanupOldThreads(7);
}

const sendMediaGroupToReconciliationChat = (ctx, items) => forwardMediaGroup(ctx, items, 'reconciliation');

async function backToMainMenu(ctx) {
  const state = getState(ctx.from.id);

  if (state?.mileageProcessing) {
    return { status: 'mileage_processing' };
  }

  clearState(ctx.from.id);

  const message = state?.savedMileage
    ? '⬅️ Возвращаю в меню.'
    : state?.mileageRow
      ? '⬅️ Возвращаю в меню. Пробег не сохранён.'
      : '⬅️ Возвращаю в меню.';

  return { status: 'back_to_menu', message };
}

async function showIssuesMenu(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: 'access_denied' };
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
    return { status: 'unavailable' };
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'issues_back')]);

  await ctx.replyWithHTML(
    '⚠️ <b>Проблема с заказом</b>\n\nВыберите чат для обращения:',
    Markup.inlineKeyboard(buttons)
  );
  return { status: 'showing_issues' };
}

// Парсим ADMIN_IDS из .env. Кэшируем результат в _adminIdsCache, чтобы
// не разбирать строку на каждом сообщении (раньше это происходило в
// 5+ местах кода).


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

function logOcrFeedback(telegramId, ocrMileage, confirmedMileage, sourceBuffer, meta = {}) {
  if (!Number.isFinite(confirmedMileage) || confirmedMileage <= 0) return;

  const isMismatch = ocrMileage !== confirmedMileage;

  if (isMismatch) {
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

    if (sourceBuffer) {
      saveOcrDebugImage(sourceBuffer, {
        status: 'ocr_mismatch',
        ocrResult: ocrMileage,
        userCorrectedValue: confirmedMileage,
        telegramId,
        stage: meta.stage || null,
        workplace: meta.workplace || null,
        fio: meta.fio || null,
        fileId: meta.fileId || null
      });
    }
  } else if (ocrMileage === confirmedMileage && ocrMileage !== null) {
    updateOcrDebugStatus(meta.fileId, 'confirmed_ok');
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

async function buildMileageRecognitionOptions(state) {
  return {
    minMileage: getMinMileageThreshold(),
    maxMileage: null,
    stage: state?.stage || null
  };
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

const _workplaceKeys = Object.values(WORKPLACE_KEY_MAP).concat(['all']).join('|');

async function replaceMileageFlow(ctx, stage) {
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: 'no_profile' };
  }

  try {
    const result = await prepareMileage(profile.fio, profile.workplace, stage);

    if (result.notFound) {
      return { status: 'not_found', result, workplace: profile.workplace };
    }

    setState(ctx.from.id, makeMileageState(ctx.from.id, applyProfile(result, profile), { source: 'mileage' }));
    console.log('ожидание замены пробега', stage);
    await ctx.replyWithHTML(`📷 <b>Замена пробега</b>\n\nОтправьте фото для: <b>${esc(formatStage(stage))}</b>`, skipMileageKeyboard());
    return { status: 'awaiting_photo' };
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    return { status: 'error' };
  }
}

async function replaceTimeAction(ctx, stage) {
  const profile = await ensureProfile(ctx);
  if (!profile) return { status: 'no_profile' };

  try {
    const result = await replaceTime(profile.fio, profile.workplace, stage);

    if (result.notFound) {
      return { status: 'not_found', result, workplace: profile.workplace };
    }

    console.log('время записано', `replace_${stage}`);
    clearState(ctx.from.id);
    return { status: 'replaced', stage, timeValue: result.timeValue };
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    return { status: 'error' };
  }
}

async function handleRouteSheetPhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  console.log('фото маршрутного листа получено');
  const date = getTodayText();
  const routeSheetNumber = getNextRouteSheetNumber(state, date);
  logRouteSheetPhoto(telegramId, fileId, state, date, routeSheetNumber);

  try {
    const forwarded = await sendPhotoToRouteSheetChat(ctx, fileId, buildRouteSheetCaption(state, routeSheetNumber, ctx.from.id));
    savePhotoThread(forwarded, ctx.from.id, 'route_sheet');

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

async function finalizeReconciliationPostSend(ctx, state, telegramId, totalOrders) {
  const errors = [];

  if (totalOrders && totalOrders > 0 && state.fio && state.workplace) {
    const timezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
    const { day } = getCurrentDateInfo(timezone);

    try {
      const result = await updateEfficiencyOrders(state.fio, state.workplace, day, totalOrders);
      if (result.ok) {
        console.log(`эффективность: записано ${totalOrders} заказов для ${state.fio}, день ${day}, ячейка ${result.cell}`);
      } else {
        console.error('эффективность: не удалось записать', result.error);
        errors.push('заказы в таблицу эффективности');
      }
    } catch (effError) {
      console.error('эффективность: ошибка записи', effError.message || effError);
      errors.push('заказы в таблицу эффективности');
    }
  }

  if (errors.length > 0) {
    return { status: 'partial_error', errors };
  }
  return { status: 'ok' };
}

async function handleReconciliationPhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  const photosSent = (state.reconciliationPhotosSent || 0) + 1;
  const total = state.reconciliationTotal || 1;
  const isTerminal = state.device === 'Терминал';
  const isTerminalFirstPhoto = isTerminal && photosSent === 1;

  if (isTerminalFirstPhoto) {
    const cashInfo = await recognizeReconciliationCashSafe(ctx, fileId, 'Терминал');
    const cashAmount = cashInfo.amount;
    const shouldAttachCash = cashInfo.valid && cashAmount > 0;
    const cashFormatted = shouldAttachCash ? formatMoneyRu(cashAmount) : null;

    const captionLines = [
      `📊 Сверки — Терминал (статистика)`,
      `👤 <a href="tg://user?id=${telegramId}">${esc(getEmployeeDisplayName(state.fio))}</a>`,
      `🏬 ${esc(state.workplace || 'не указано')}`
    ];

    if (shouldAttachCash && cashFormatted) {
        const rawAmount = Number(cashAmount);
      if (!Number.isFinite(rawAmount) || rawAmount < 1 || rawAmount > MAX_REASONABLE_CASH_AMOUNT) {
        console.log('сверка OCR: сумма наличных вне допустимого диапазона', rawAmount);
      } else {
        const totalAmount = roundMoney(rawAmount);
        const totalFormatted = formatMoneyRu(totalAmount);
        const currentNumberOnly = formatMoneyRuNumber(rawAmount) || String(cashFormatted).replace(/\s*₽$/, '');

        captionLines.push(`💵 К сдаче в следующую смену: <code>${esc(currentNumberOnly)}</code> ₽`);

        setPendingCash(telegramId, {
          amount: totalAmount,
          formatted: totalFormatted,
          orders: 1,
          workplace: state.workplace || null,
          sourceLabel: 'Терминал',
          updatedAt: new Date().toISOString(),
          fileId
        });
      }
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
      cashOrders: shouldAttachCash ? 1 : 0,
      cashAmount: cashAmount,
      totalOrders: null,
      cashApplied: Boolean(shouldAttachCash),
      reason: shouldAttachCash ? 'ok' : 'no_cash'
    });

    setState(telegramId, {
      ...state,
      reconciliationPhotosSent: photosSent,
      reconciliationPhoto1FileId: fileId,
      reconciliationPhoto1Caption: caption,
      reconciliationPhoto1TotalOrders: cashInfo.totalOrders || null,
      reconciliationPhoto1OcrReason: shouldAttachCash ? 'ok' : (cashInfo.reason || 'no_cash')
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

      if (!forwarded || !Array.isArray(forwarded) || forwarded.length === 0) {
        await ctx.replyWithHTML('⚠️ Временные проблемы с отправкой.\nСообщите администратору.', routeSheetKeyboard());
        return;
      }
      savePhotoThread(forwarded[0], ctx.from.id, 'reconciliation');

      clearState(telegramId);
      const ocrWarning = !state.reconciliationPhoto1TotalOrders && state.reconciliationPhoto1OcrReason
        ? `\n\n⚠️ OCR не распознал заказы/наличные. Фото отправлены, но данные не записаны автоматически.`
        : '';
      const totalOrders = state.reconciliationPhoto1TotalOrders;
      const postRes = await finalizeReconciliationPostSend(ctx, state, telegramId, totalOrders);
      return { status: 'photos_sent_terminal', ocrWarning, postRes };
    } catch (error) {
      console.error('telegram send reconciliation album error', error);
      await ctx.replyWithHTML('⚠️ Не удалось отправить фото.\nПопробуйте ещё раз или обратитесь к администратору.', routeSheetKeyboard());
    }
    return;
  }

  const label = 'Пин-Панель';
  const cashInfo = await recognizeReconciliationCashSafe(ctx, fileId, label);
  const cashAmount = cashInfo.amount;
  const shouldAttachCash = cashInfo.valid && cashAmount > 0;
  const cashFormatted = shouldAttachCash ? formatMoneyRu(cashAmount) : null;

  const captionLines = [
    `📊 Сверки — ${esc(label)}`,
    `👤 <a href="tg://user?id=${telegramId}">${esc(getEmployeeDisplayName(state.fio))}</a>`,
    `🏬 ${esc(state.workplace || 'не указано')}`
  ];

  if (shouldAttachCash && cashFormatted) {
      const rawAmount = Number(cashAmount);
    if (!Number.isFinite(rawAmount) || rawAmount < 1 || rawAmount > MAX_REASONABLE_CASH_AMOUNT) {
      console.log('сверка OCR: сумма наличных вне допустимого диапазона', rawAmount);
    } else {
      const totalAmount = roundMoney(rawAmount);
      const totalFormatted = formatMoneyRu(totalAmount);
      const currentNumberOnly = formatMoneyRuNumber(rawAmount) || String(cashFormatted).replace(/\s*₽$/, '');

      captionLines.push(`💵 К сдаче в следующую смену: <code>${esc(currentNumberOnly)}</code> ₽`);

      setPendingCash(telegramId, {
        amount: totalAmount,
        formatted: totalFormatted,
        orders: 1,
        workplace: state.workplace || null,
        sourceLabel: label,
        updatedAt: new Date().toISOString(),
        fileId
      });
    }
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
    cashOrders: shouldAttachCash ? 1 : 0,
    cashAmount: cashAmount,
    totalOrders: null,
    cashApplied: Boolean(shouldAttachCash),
    reason: shouldAttachCash ? 'ok' : 'no_cash'
  });

  try {
    const forwarded = await sendPhotoToReconciliationChat(ctx, fileId, caption);

    if (!forwarded) {
      await ctx.replyWithHTML('⚠️ Временные проблемы с отправкой.\nСообщите администратору.', routeSheetKeyboard());
      return;
    }
    savePhotoThread(forwarded, telegramId, 'reconciliation');

    clearState(telegramId);
    const ocrWarning = !shouldAttachCash && !cashInfo.totalOrders
      ? `\n\n⚠️ OCR не распознал сумму наличных. Фото отправлено, но данные не записаны автоматически.`
      : '';
    const postRes = await finalizeReconciliationPostSend(ctx, state, telegramId, cashInfo.totalOrders);
    return { status: 'photos_sent', total, ocrWarning, postRes };
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
    fileId,
    mileageProcessing: true
  };
  setState(telegramId, photoState);

  const ocrAvailable = isGeminiOcrEnabled();
  if (!ocrAvailable) {
    setState(telegramId, {
      ...photoState,
      mileageProcessing: false,
      awaitingMileagePhoto: true,
      awaitingManualMileage: true,
      recognizedMileage: null,
      ocrValue: null
    });
    try {
      const forwarded = await sendPhotoToWorkChat(ctx, fileId, buildPhotoCaption(state, telegramId));
      savePhotoThread(forwarded, telegramId, 'mileage');
    } catch (error) {
      console.error('telegram send photo error', error);
    }
    await ctx.replyWithHTML('⚠️ Авто-распознавание сейчас недоступно.\nВведите пробег вручную или нажмите «⏭️ Пропустить».', mileageConfirmKeyboard());
    return;
  }

  const ocrHealthy = await checkGeminiOcrHealth();
  if (!ocrHealthy) {
    console.warn('Gemini OCR health check failed, falling back to manual input');
    setState(telegramId, {
      ...photoState,
      mileageProcessing: false,
      awaitingMileagePhoto: true,
      awaitingManualMileage: true,
      recognizedMileage: null,
      ocrValue: null
    });
    try {
      const forwarded = await sendPhotoToWorkChat(ctx, fileId, buildPhotoCaption(state, telegramId));
      savePhotoThread(forwarded, telegramId, 'mileage');
    } catch (error) {
      console.error('telegram send photo error', error);
    }
    await ctx.replyWithHTML('⚠️ Сервер распознавания недоступен.\nВведите пробег вручную или нажмите «⏭️ Пропустить».', mileageConfirmKeyboard());
    return;
  }

  await ctx.replyWithHTML('📸 Фото принято. Считываю пробег...');

  const chatId = ctx.chat.id;
  const telegram = ctx.telegram;

  withTimeout(processMileagePhotoInBackground(telegram, chatId, telegramId, photoState, fileId, photoState), 120000, 'mileage processing').catch((err) => {
    if (err.message && err.message.includes('timeout')) {
      console.error('mileage processing timeout');
      telegram.sendMessage(chatId, '⚠️ Превышено время распознавания. Введите пробег вручную или нажмите «⏭️ Пропустить».', { parse_mode: 'HTML' }).catch(() => {});
    } else {
      console.error('mileage bg error:', err.message);
    }
  });
}

async function processMileagePhotoInBackground(telegram, chatId, telegramId, originalState, fileId, photoState) {
  const sendMsg = async (html, extra) => {
    try {
      await telegram.sendMessage(chatId, html, { parse_mode: 'HTML', ...(extra || {}) });
    } catch (e) {
      console.error('background sendMsg error', e.message);
    }
  };

  try {
    console.log('mileage bg: start processing', { telegramId, fileId });

    const [recognitionOptions, forwardedResult] = await Promise.all([
      buildMileageRecognitionOptions(originalState),
      forwardPhoto({ telegram }, fileId, buildPhotoCaption(originalState, telegramId), 'work').catch((error) => {
        console.error('telegram send photo error', error);
        return null;
      })
    ]);
    savePhotoThread(forwardedResult, telegramId, 'mileage');
    console.log('mileage bg: recognition options built', recognitionOptions);

    const sourceBuffer = await downloadTelegramFile({ telegram }, fileId);
    console.log('mileage bg: file downloaded', { size: sourceBuffer?.length });

    const ocrResult = await recognizeMileage({ telegram, chat: { id: chatId } }, fileId, {
      ...recognitionOptions,
      sourceBuffer,
      onStatus: async (msg) => {
        try { await sendMsg(msg); } catch (e) { /* ignore */ }
      }
    });

    const mileageValue = ocrResult?.mileage || null;
    const ocrCandidates = ocrResult?.candidates || [];
    console.log('mileage bg: OCR result', { mileageValue, candidateCount: ocrCandidates.length });

    if (!mileageValue) {
      if (sourceBuffer) {
        saveOcrDebugImage(sourceBuffer, {
          status: ocrCandidates.length > 0 ? 'ocr_weak' : 'ocr_fail',
          ocrResult: ocrCandidates.length > 0 ? ocrCandidates[0].mileage : null,
          userCorrectedValue: null,
          telegramId,
          stage: originalState.stage,
          workplace: originalState.workplace,
          fio: originalState.fio,
          fileId
        });
      }

      const cs = getState(telegramId);
      if (cs?.fileId === fileId) {
        setState(telegramId, {
          ...photoState,
          mileageProcessing: false,
          awaitingMileagePhoto: true,
          awaitingManualMileage: true,
          recognizedMileage: null,
          ocrValue: null
        });
      }

      let failMsg = '⚠️ <b>Не удалось распознать пробег</b>\n\n';
      if (ocrCandidates.length > 0) {
        const candidateList = ocrCandidates.slice(0, 3).map((c) => `<code>${c.mileage}</code> км`).join(', ');
        failMsg += `Возможные значения: ${candidateList}\n\n`;
      }
      failMsg += 'Отправьте фото повторно крупным планом, введите вручную или нажмите «⏭️ Пропустить».';
      await sendMsg(failMsg, mileageConfirmKeyboard());
      return;
    }

    // OCR успешно распознал — проверяем, не изменил ли пользователь состояние
    const currentState = getState(telegramId);
    if (!currentState || currentState.fileId !== fileId || !currentState.mileageProcessing) {
      console.log('mileage bg: state changed, ignoring OCR result');
      return;
    }

    await saveMileageFromState(
      { from: { id: telegramId }, telegram, replyWithHTML: sendMsg },
      mileageValue,
      { sourceBuffer, telegram, chatId, fallbackState: originalState }
    );
  } catch (error) {
    console.error('background mileage processing error', error);
    await sendMsg('⚠️ <b>Ошибка обработки фото</b>\nПопробуйте ещё раз.', mileageConfirmKeyboard());
  } finally {
    const cs = getState(telegramId);
    if (cs && cs.fileId === fileId && cs.mileageProcessing) {
      setState(telegramId, {
        ...cs,
        mileageProcessing: false,
        awaitingMileagePhoto: true,
        awaitingManualMileage: true
      });
    }
  }
}

async function handleManualTime(ctx, state, text) {
  const telegramId = ctx.from.id;
  const timeValue = normalizeTimeValue(text);

  if (!timeValue) {
    await ctx.replyWithHTML(
      '❌ Неверный формат времени.\n\n' +
      'Поддерживаются: <code>7</code>, <code>7,5</code>, <code>07:30</code>, <code>08:46</code>, <code>08.46</code>, <code>8 14</code> (часы 0–24).\n' +
      'Минуты округляются до ближайших 30.'
    );
    return 'error';
  }

  try {
    await updateCourierTime(state.courierRow, state.day, state.stage, timeValue, state.workplace);
    clearState(telegramId);
    console.log('время изменено', state.stage);
    const icon = state.stage === 'start' ? '🟢' : '🔴';
    const label = state.stage === 'start' ? 'Старт' : 'Конец';
    await ctx.replyWithHTML(`${icon} <b>${label} смены</b> изменён: <code>${esc(timeValue)}</code>`);
    return 'done';
  } catch (error) {
    console.error('ошибка Google Sheets', error);
    await ctx.replyWithHTML('⚠️ Не удалось изменить время.\nПопробуйте ещё раз или обратитесь к администратору.');
    return 'error';
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
  const id = telegramId || ctx.from.id;
  setState(id, { awaitingSwitchUser: true });
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
  savePendingUpdates();
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
    await ctx.replyWithHTML('❌ Введите пробег от <b>2 до 6 цифр</b>.\n\nНапример: <code>25408</code>');
    return 'error';
  }
  await saveMileageFromState(ctx, Number(text));
  return 'done';
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

let _shutdownInProgress = false;

function flushAllSync() {
  try { flushFunReactionsNow(); } catch (e) { console.error('flushFunReactionsNow failed', e.message); }
}

async function shutdown(signal) {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;

  console.log(`shutdown initiated by ${signal}`);
  try {
    checkpoint();
  } catch (_) {}
  flushAllSync();

  try {
    await makeBackup('pre-shutdown');
  } catch (e) {
    console.error('pre-shutdown backup failed', e.message);
  }

  if (funReactionCleanupTimer) {
    clearInterval(funReactionCleanupTimer);
    funReactionCleanupTimer = null;
  }

  try {
    await bot.stop(signal);
  } catch (e) {
    console.error('bot.stop failed', e.message);
  }

  setTimeout(() => {
    console.log('forced exit after shutdown timeout');
    process.exit(0);
  }, 5000);
}

bot.catch(async (error, ctx) => {
  console.error('bot error', error.message);
  try {
    await ctx.replyWithHTML('⚠️ Произошла ошибка. Попробуйте ещё раз или используйте /start.');
  } catch (replyErr) {
    console.error('failed to send error reply:', replyErr.message);
  }
});

process.on('uncaughtException', (error) => {
  console.error('uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason);
  shutdown('unhandledRejection');
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

const services = {
  getUserField, setUserField, markUserSeen, getAdminIds,
  getVersion, ensureProfile, getUserRole, getTimeGreeting,
  esc, getEmployeeDisplayName, askForFio, logistMainMenu,
  getMenuForRole, isLogist, askForCarNumber, askForWorkplace,
  askForDevice, sendHelp, backToMainMenu,
  isTimeButton, isMileageButton,
  isAdminUser, getSheetAccessUsers, addSheetAccessUser, removeSheetAccessUser,
  _pendingUpdates, savePendingUpdates, notifyUsersAboutUpdate,
  setState, getState, clearState,
  clearShiftStatus,
  // text router flows
  punchTimeFlow, mileageFlow, routeSheetFlow, reconciliationFlow,
  showPendingCashStatus, showIssuesMenu,
  handleSwitchUser, handleSheetsInfo, handleMyId, showHistoryDatePicker, showDebtorsList,
  saveCarNumber, saveWorkplace, saveDevice, authorizeFio,
  handleManualTime, handleUpdateEditText, handleManualMileageInput,
  requireFio, roleChoiceKeyboard, getSettingsMenuForRole, getProfileMenuForRole,
  // courier helpers
  formatNoSheetMessage, makeMileageState, applyProfile,
  replaceMileageFlow, replaceTimeAction,
  handleRouteSheetPhoto, handleReconciliationPhoto, handleMileagePhoto,
  finalizeReconciliationPostSend, saveMileageFromState,
  getTodayText, getNextRouteSheetNumber, logRouteSheetPhoto,
  buildRouteSheetCaption, sendPhotoToRouteSheetChat, savePhotoThread,
  normalizeTimeValue, formatStage, formatMoneyRu,
  notifyLogistsAboutSelfClearance, sendFunReaction,
  courierMainMenu,
  // logist helpers
  pokeCourier, showCashHistoryForDate,
  // common business
  getPendingCash, setUserField, setCashConfirmationStatus, clearPendingCashAndReminders,
  logCashAction, deleteUser,
  saveOcrDebugImage, updateOcrDebugStatus,
  getFullProfile,
  getReminder, updateReminder, deleteReminder, getSelfClearanceRequest,
  findLogistsForWorkplace, getDebtors, cleanupStaleReminders, getCashHistory,
  WORKPLACE_FEATURES,
  Markup, BUTTONS, getCurrentDateInfo,
  // sheets & ocr
  readCell, updateCell, flushSheetUpdates,
  db, checkpoint, saveThread, findThreadByGroupMessage, findThreadById, saveForwardedMessage, findForwardedMessage, cleanupOldThreads,
  isSheetAccessUser,
  WORKPLACES, LIMITS,
  getMileageStageCell, buildMileageRecognitionOptions, parseMileageNumber,
  checkGeminiOcrHealth, recognizeMileage, downloadTelegramFile,
  isGeminiOcrEnabled, recognizeTextWithGemini, getMinMileageThreshold,
  logOcrFeedback, isEmptyCell, isScheduleMarker, getMileageColumns: getMileageColumnsByDay,
  roundTimeToHalfHour, getColumnLetter, getCourierColumnsByDay, manualMileageKeyboard, skipMileageKeyboard,
  prepareMileage, replaceTime, punchTime,
  updateCourierTime, updateMileage,
  // misc
  openShopNotify,
  sendCommandsList
};

setupCommands(bot, services);
setupAdmin(bot, services);
setupReplyForwarding(bot, services);
setupTextRouter(bot, services);
setupCourier(bot, services);
setupLogist(bot, services);

async function startBot(retry = 0) {
  if (process.env.BOT_DISABLED === 'true') {
    console.log('bot disabled — .env BOT_DISABLED=true');
    return;
  }
  try {
    const { version, changed, changedFiles, updates } = checkVersion();
    initGoogleSheets();
    setNotifyAdminCallback(notifyAdmins);
    loadPendingUpdatesFromDb();
    const removedMonths = cleanupOldMonths();
    if (removedMonths) {
      console.log('cleaned up old month(s) from storage');
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
        askAdminsAboutUpdate(version, changedFiles, updates).catch((error) => {
          console.error('admin update ask fatal', error.message || error);
        });
      }, 3000);
    }

    // Очистка клавиатур во всех топиках и группах при старте
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
