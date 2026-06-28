require("dotenv").config();
require("./logger").initLogger();

const fs = require("fs");
const path = require("path");

const crypto = require("crypto");

const { Telegraf, Markup } = require("telegraf");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
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
  getValues,
  flushSheetUpdates,
  getSheetConfig,
  updateEfficiencyOrders,
  loadPendingUpdatesFromDb,
  setNotifyAdminCallback,
} = require("./services/googleSheets");
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
  clearShiftStatus,
} = require("./services/storage");
const {
  recognizeMileage,
  downloadTelegramFile,
  isGeminiOcrEnabled,
  recognizeTextWithGemini,
  getMinMileageThreshold,
  checkGeminiOcrHealth,
} = require("./services/mileageOcr");
const {
  saveOcrDebugImage,
  updateOcrDebugStatus,
} = require("./services/ocrDebug");
const {
  getReconciliationOcrTimeoutMs,
  roundMoney,
  emptyReconciliationCash,
  recognizeReconciliationCashSafe,
  shouldWarnAboutReconciliationOcr,
} = require("./services/reconciliationOcr");
const {
  getCurrentDateInfo,
  getColumnLetter,
  getMileageColumnsByDay,
  getCourierColumnsByDay,
  roundMinutesToHalfHour,
  roundTimeToHalfHour,
  isEmptyCell,
  isScheduleMarker,
  withTimeout,
  styledButton,
  normalizeFio,
} = require("./utils");
const safeLog = require("./utils/safeLog");
const replyManager = require("./services/replyManager");
const funReactions = require("./services/funReactions");
const {
  forwardPhoto,
  forwardMediaGroup,
  sendPhotoToWorkChat,
  sendPhotoToRouteSheetChat,
  sendPhotoToReconciliationChat,
  sendMediaGroupToReconciliationChat,
  savePhotoThread,
} = require("./services/photoForwarder");
const {
  runBackupCycle,
  makeBackup,
  BACKUP_INTERVAL_MS,
} = require("./services/backup");
const {
  checkVersion,
  getVersion,
  getLatestChangelogNotes,
  getChangelogBump,
} = require("./services/version");
const { registerSheetCommand } = require("./sheetCommand");
const {
  WORKPLACES,
  DEVICES,
  ROLES,
  LIMITS,
  WORKPLACE_FEATURES,
  WORKPLACE_KEY_MAP,
  BUTTONS,
} = require("./config");
const { isAdminUser, getAdminIds } = require("./services/auth");
const setupCommands = require("./handlers/commands");
const setupAdmin = require("./handlers/admin");
const setupAdminPanel = require("./handlers/adminPanel");
const setupTextRouter = require("./handlers/textRouter");
const setupCourier = require("./handlers/courier");
const setupLogist = require("./handlers/logist");
const setupReplyForwarding = require("./handlers/replyForwarding");
const {
  workplaceMenu,
  deviceMenu,
  logistMainMenu,
  getMenuForRole,
  getSettingsMenuForRole,
  getProfileMenuForRole,
  settingsInlineKeyboard,
  profileInlineKeyboard,
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
  courierMainMenu,
} = require("./menus/keyboards");

const db = require("./db");
const {
  checkpoint,
  saveThread,
  findThreadByGroupMessage,
  findThreadById,
  saveForwardedMessage,
  findForwardedMessage,
  cleanupOldThreads,
} = require("./db");

function getState(telegramId) {
  const row = db
    .prepare("SELECT data FROM states WHERE telegramId = ?")
    .get(String(telegramId));
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function setState(telegramId, state) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO states (telegramId, data) VALUES (?, ?)",
  );
  stmt.run(String(telegramId), JSON.stringify(state));
}

function clearState(telegramId) {
  db.prepare("DELETE FROM states WHERE telegramId = ?").run(String(telegramId));
}

// Per-user state lock to prevent read-modify-write races
const stateLocks = new Map();
const STATE_LOCK_TIMEOUT_MS = 30000;

async function withState(telegramId, fn, timeoutMs = STATE_LOCK_TIMEOUT_MS) {
  const id = String(telegramId);

  // Wait for any existing lock
  while (stateLocks.has(id)) {
    try {
      await stateLocks.get(id);
    } catch {
      /* ignore */
    }
  }

  let release;
  const lockPromise = new Promise((resolve) => {
    release = resolve;
  });
  stateLocks.set(id, lockPromise);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`state lock timeout for ${id}`)),
      timeoutMs,
    );
  });

  try {
    const state = getState(id);
    const result = await Promise.race([fn(state), timeoutPromise]);
    if (result !== undefined) {
      setState(id, result);
    }
    return result;
  } finally {
    stateLocks.delete(id);
    release();
  }
}

function withStateSync(telegramId, fn) {
  const id = String(telegramId);
  if (stateLocks.has(id)) {
    throw new Error(
      `State lock held for ${id}; use withState for async operations`,
    );
  }
  const state = getState(id);
  const result = fn(state);
  if (result !== undefined) {
    setState(id, result);
  }
  return result;
}

// Per-user rate limiting for photo/OCR processing
const MAX_MILEAGE_PHOTOS_PER_MINUTE = 5;
const MILEAGE_PHOTO_WINDOW_MS = 60 * 1000;
const userMileagePhotoTimestamps = new Map();

function isMileagePhotoRateLimited(telegramId) {
  const id = String(telegramId);
  const now = Date.now();
  let timestamps = userMileagePhotoTimestamps.get(id) || [];
  timestamps = timestamps.filter((ts) => now - ts < MILEAGE_PHOTO_WINDOW_MS);
  userMileagePhotoTimestamps.set(id, timestamps);

  if (timestamps.length >= MAX_MILEAGE_PHOTOS_PER_MINUTE) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// WORKPLACES, DEVICES — теперь из config.js (см. импорт выше)

function isLogist(telegramId) {
  return getUserRole(telegramId) === "logist";
}

async function showDebtorsList(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== "logist") {
    return { status: "access_denied" };
  }

  const workplace = getUserField(telegramId, "workplace");
  if (!workplace) {
    return { status: "no_workplace" };
  }

  const features = WORKPLACE_FEATURES[workplace];
  if (!features || !features.cashCollection) {
    return { status: "no_cash_collection" };
  }

  cleanupStaleReminders();

  const debtors = getDebtors(workplace);

  if (debtors.length === 0) {
    return { status: "no_debt" };
  }

  const totalAmount = debtors.reduce((sum, d) => sum + d.amount, 0);
  const formattedTotal = formatMoneyRu(totalAmount);

  await ctx.replyWithHTML(
    `💳 Курьеры с долгами\n` +
      `──────────────\n\n` +
      `🏬 ${esc(workplace)}\n` +
      `💰 Всего: <code>${formattedTotal}</code> ₽\n\n` +
      debtors
        .map(
          (d) => `• ${esc(d.fio)} — <code>${formatMoneyRu(d.amount)}</code> ₽`,
        )
        .join("\n"),
    debtorListKeyboard(debtors, workplace),
  );
  return { status: "showing_debtors" };
}

async function pokeCourier(ctx, courierId) {
  const logistId = ctx.from.id;
  const logistFio = getUserField(logistId, "fio") || "Логист";
  const logistWorkplace = getUserField(logistId, "workplace");
  const courierRecord = getUserField(courierId, "fio")
    ? {
        fio: getUserField(courierId, "fio"),
        workplace: getUserField(courierId, "workplace"),
      }
    : null;

  if (!courierRecord || !courierRecord.fio) {
    await ctx.answerCbQuery("⚠️ Курьер не найден.");
    return;
  }

  const selfClearance = getSelfClearanceRequest(courierId);
  if (selfClearance) {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `⏳ ${esc(courierRecord.fio)} уже отметил сдачу\n\n` +
        `Ожидает подтверждения: <code>${esc(selfClearance.formatted || String(selfClearance.amount))}</code> ₽`,
      Markup.inlineKeyboard([
        [styledButton("✅ Подтвердить", `sc_appr_${courierId}`, "success")],
        [styledButton("❌ Отклонить", `sc_decl_${courierId}`, "danger")],
      ]),
    );
    return;
  }

  const pendingCash = getPendingCash(courierId);
  const amount = Number(pendingCash?.amount || 0);
  if (!Number.isFinite(amount) || amount < 1) {
    await ctx.answerCbQuery("✅ Курьер уже сдал деньги.");
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText("✅ Курьер уже сдал деньги.");
      } catch (e) {
        /* ignore */
      }
    }
    return;
  }

  const formatted = pendingCash?.formatted || formatMoneyRu(amount);
  const shortId = crypto.randomBytes(4).toString("hex");

  const reminderData = {
    logistId: String(logistId),
    logistChatId: String(logistId),
    logistFio: logistFio,
    courierId: String(courierId),
    courierFio: courierRecord.fio,
    amount: amount,
    formatted: formatted,
    workplace: courierRecord.workplace || logistWorkplace,
    status: "reminded",
    createdAt: new Date().toISOString(),
    logistMsgId: null,
    courierMsgId: null,
  };

  setReminder(shortId, reminderData);

  logCashAction({
    logistId: String(logistId),
    logistFio: logistFio,
    courierId: String(courierId),
    courierFio: courierRecord.fio,
    workplace: courierRecord.workplace || logistWorkplace,
    amount: amount,
    action: "reminded",
  });

  const workplaceLabel = courierRecord.workplace || "не указано";
  const courierMsg =
    `🔔 Логист ${esc(logistFio)} напоминает\n` +
    `──────────────\n\n` +
    `💰 Сумма: <code>${esc(formatted)}</code> ₽\n` +
    `🏬 Магазин: <b>${esc(workplaceLabel)}</b>\n\n` +
    `Сдали деньги?`;

  try {
    const sent = await bot.telegram.sendMessage(courierId, courierMsg, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏃 Уже бегу",
              callback_data: `ack_${shortId}`,
              style: "primary",
            },
          ],
          [
            {
              text: "✅ Сдал",
              callback_data: `c_${shortId}`,
              style: "success",
            },
          ],
        ],
      },
    });

    const msgId = sent.message_id;
    updateReminder(shortId, { courierMsgId: msgId });

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("✅ Напоминание отправлено");
      try {
        await ctx.editMessageText(
          `✅ Напоминание отправлено\n\n${esc(courierRecord.fio)} — <code>${esc(formatted)}</code> ₽`,
          { parse_mode: "HTML" },
        );
      } catch (e) {
        /* ignore */
      }
    } else {
      await ctx.replyWithHTML(
        `✅ Напоминание отправлено\n\n${esc(courierRecord.fio)} — <code>${esc(formatted)}</code> ₽`,
      );
    }
  } catch (e) {
    safeLog.error("failed to send reminder to courier", e);
    deleteReminder(shortId);
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("⚠️ Не удалось отправить уведомление");
    } else {
      await ctx.replyWithHTML(
        "⚠️ Не удалось отправить уведомление курьеру\n\nВозможно, он заблокировал бота.",
      );
    }
  }
}

async function showHistoryDatePicker(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== "logist") {
    return { status: "access_denied" };
  }

  const workplace = getUserField(telegramId, "workplace");
  const features = WORKPLACE_FEATURES[workplace];
  if (!features || !features.cashCollection) {
    return { status: "no_cash_collection" };
  }

  const timezone = process.env.APP_TIMEZONE || "Europe/Moscow";
  const buttons = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString("sv-SE", { timeZone: timezone });
    const dayLabel = d.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      timeZone: timezone,
    });
    const prefix = i === 0 ? "📅 " : "";
    buttons.push([
      styledButton(`${prefix}${dayLabel}`, `ch_${dateStr}`, "primary"),
    ]);
  }
  buttons.push([styledButton("❌ Закрыть", "close_message", "danger")]);

  await ctx.replyWithHTML(
    "📋 История сборов\n──────────────\n\nВыберите дату:",
    Markup.inlineKeyboard(buttons),
  );
  return { status: "showing_history" };
}

async function showCashHistoryForDate(ctx, dateStr) {
  const telegramId = ctx.from.id;
  const workplace = getUserField(telegramId, "workplace");
  const rows = getCashHistory(dateStr, workplace);

  const approvedRows = rows.filter(
    (r) =>
      r.action === "approved" ||
      r.action === "self_cleared" ||
      r.action === "logist_approved",
  );

  if (approvedRows.length === 0) {
    await ctx.replyWithHTML(
      `📋 История сборов\n──────────────\n\n📅 ${dateStr}\n\nНет подтверждённых сдач за эту дату.`,
    );
    return;
  }

  const total = approvedRows.reduce((sum, r) => sum + r.amount, 0);
  let msg =
    `📋 История сборов\n──────────────\n\n` +
    `📅 ${dateStr}\n💰 Всего: <code>${formatMoneyRu(total)}</code> ₽\n\n`;

  for (const row of approvedRows) {
    let icon = "✅";
    if (row.action === "self_cleared") icon = "💵";
    else if (row.action === "logist_approved") icon = "👍";
    let logistLabel;
    if (row.action === "self_cleared") {
      logistLabel = " (самостоятельно)";
    } else if (row.action === "logist_approved") {
      logistLabel = row.logistFio
        ? ` (логист: ${esc(row.logistFio)})`
        : " (логист)";
    } else {
      logistLabel = row.logistFio ? ` (логист: ${esc(row.logistFio)})` : "";
    }
    msg += `${icon} ${esc(row.courierFio)} — <code>${formatMoneyRu(row.amount)}</code> ₽${logistLabel}\n`;
  }

  await ctx.replyWithHTML(msg);
}

async function openShopNotify(ctx) {
  const telegramId = ctx.from.id;
  const role = getUserRole(telegramId);
  if (role !== "logist") {
    return { status: "access_denied" };
  }

  const workplace = getUserField(telegramId, "workplace");
  if (!workplace) {
    return { status: "no_workplace" };
  }

  const finalize = await sendLoadingMessage(ctx, "📤 Отправляю уведомление...");

  const fio = getUserField(telegramId, "fio") || "Логист";
  const chatId = process.env.SHOP_STATUS_CHAT_ID;
  if (chatId) {
    try {
      await bot.telegram.sendMessage(
        chatId,
        `🏪 <b>${esc(workplace)} — ОТКРЫТ</b> ✅\n\nЛогист: ${esc(fio)}`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      safeLog.error("shop open notify error", e.message || e);
    }
  }

  await finalize(
    `✅ Магазин открыт\n──────────────\n\n🏬 ${esc(workplace)} — ОТКРЫТ`,
    { reply_markup: getMenuForRole(telegramId).reply_markup },
  );
  return { status: "ok", workplace, handled: true };
}

async function notifyLogistsAboutSelfClearance(
  courierId,
  courierFio,
  amount,
  formatted,
  workplace,
) {
  const logists = findLogistsForWorkplace(workplace);

  const allRecipientIds = new Set();
  for (const logist of logists) {
    allRecipientIds.add(String(logist.telegramId));
  }

  const keyboard = Markup.inlineKeyboard([
    [styledButton("✅ Подтвердить", `sc_appr_${courierId}`, "success")],
    [styledButton("❌ Отклонить", `sc_decl_${courierId}`, "danger")],
  ]);

  for (const recipientId of allRecipientIds) {
    try {
      await bot.telegram.sendMessage(
        recipientId,
        `💰 <b>Курьер отметил сдачу</b>\n\n` +
          `👤 ${esc(courierFio)}\n` +
          `💵 <code>${esc(formatted)}</code> ₽\n` +
          `🏬 ${esc(workplace)}\n\n` +
          `Подтвердите сдачу:`,
        { parse_mode: "HTML", ...keyboard },
      );
    } catch (e) {
      safeLog.error(
        "failed to notify logist about self-clearance",
        recipientId,
        e.message,
      );
    }
  }
}

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  return text || null;
}

function createTelegramAgent() {
  const proxyUrl =
    normalizeProxyUrl(process.env.TELEGRAM_PROXY_URL) ||
    normalizeProxyUrl(process.env.HTTPS_PROXY) ||
    normalizeProxyUrl(process.env.HTTP_PROXY);

  if (!proxyUrl) return null;

  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch (_) {
    safeLog.error("Invalid TELEGRAM_PROXY_URL, proxy disabled");
    return null;
  }

  const protocol = String(parsed.protocol || "").toLowerCase();

  if (protocol.startsWith("socks")) {
    safeLog.log("Telegram proxy enabled (SOCKS)");
    return new SocksProxyAgent(proxyUrl);
  }

  if (protocol === "http:" || protocol === "https:") {
    safeLog.log("Telegram proxy enabled (HTTP/HTTPS)");
    return new HttpsProxyAgent(proxyUrl);
  }

  safeLog.error(`Unsupported TELEGRAM_PROXY_URL protocol: ${protocol}`);
  return null;
}

const telegramAgent = createTelegramAgent();
const bot = new Telegraf(
  process.env.BOT_TOKEN,
  telegramAgent
    ? {
        telegram: { agent: telegramAgent },
      }
    : undefined,
);

// Middleware: замер времени обработки запросов
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (ms > 500) {
    const updateType = ctx.updateType || "unknown";
    const text = ctx.message?.text || ctx.callbackQuery?.data || "";
    safeLog.log(
      `⚠️ Медленный запрос: ${ms}мс, тип: ${updateType}, от: ${ctx.from?.id}, текст/данные: ${text}`,
    );
  }
});

const photoLogPath = path.join(__dirname, "photo-log.jsonl");
const routeSheetLogPath = path.join(__dirname, "route-sheet-log.jsonl");
const reconciliationLogPath = path.join(__dirname, "reconciliation-log.jsonl");
function esc(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isButton(text, button, legacyText) {
  return text === button || text === legacyText;
}

function formatStage(stage) {
  return stage === "start" ? "начало смены" : "конец смены";
}

function getTimeGreeting(
  timezone = process.env.APP_TIMEZONE || "Europe/Moscow",
) {
  const hour = parseInt(
    new Date().toLocaleString("en-GB", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }),
  );
  if (hour >= 5 && hour < 12) return "Доброе утро";
  if (hour >= 12 && hour < 18) return "Добрый день";
  if (hour >= 18 && hour < 23) return "Добрый вечер";
  return "Доброй ночи";
}

function formatPhotoStatus(stage) {
  return stage === "start" ? "🟢 Старт" : "🔴 Конец";
}

function getEmployeeDisplayName(fio) {
  const parts = String(fio || "")
    .trim()
    .split(/\s+/);
  if (parts.length >= 2) {
    return parts[1] + " " + parts[0];
  }
  return fio || "";
}

// Telegram ограничивает caption до 1024 символов (НЕ 4096 как для текста).
// Длинное ФИО + магазин могут превысить лимит, тогда API вернёт ошибку.
const TELEGRAM_CAPTION_LIMIT = LIMITS.TELEGRAM_CAPTION_LIMIT;

function truncateCaption(text, limit = TELEGRAM_CAPTION_LIMIT) {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + "…";
}

function buildPhotoCaption(state, telegramId) {
  const name = getEmployeeDisplayName(state.fio);
  const nameLine = telegramId
    ? `👤 <a href="tg://user?id=${telegramId}">${esc(name)}</a>`
    : `👤 ${name}`;
  return truncateCaption(
    [
      formatPhotoStatus(state.stage),
      nameLine,
      `🚙 ${state.auto || "не указано"}`,
      `🏬 ${state.workplace || "не указано"}`,
    ].join("\n"),
  );
}

function buildRouteSheetCaption(state, routeSheetNumber, telegramId) {
  const name = getEmployeeDisplayName(state.fio);
  const nameLine = telegramId
    ? `👤 <a href="tg://user?id=${telegramId}">${esc(name)}</a>`
    : `👤 ${name}`;
  return truncateCaption(
    [
      `📄 Маршрутный лист №${routeSheetNumber}`,
      nameLine,
      `🏬 ${state.workplace || "не указано"}`,
    ].join("\n"),
  );
}

function getTodayText() {
  const timezone = process.env.APP_TIMEZONE || "Europe/Moscow";
  return getCurrentDateInfo(timezone).dateText;
}

const MAX_LOG_SIZE = LIMITS.MAX_LOG_SIZE_BYTES;

async function trimLogIfNeeded(filePath) {
  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size < MAX_LOG_SIZE) return;
    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.split("\n");
    const half = Math.ceil(lines.length / 2);
    const trimmed = lines.slice(-half).join("\n");
    const tmp = filePath + ".tmp";
    await fs.promises.writeFile(tmp, trimmed, "utf8");
    await fs.promises.rename(tmp, filePath);
  } catch (_) {}
}

async function appendLog(filePath, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.promises.appendFile(filePath, line, "utf8");
  } catch (error) {
    safeLog.error("log write error", filePath, error.message);
  }
  await trimLogIfNeeded(filePath);
}

// ===== Legacy fun-reaction wrapper for ctx.replyWithHTML =====
// TODO: постепенно заменить все ctx.replyWithHTML на ctx.sendBotReply и убрать этот middleware.
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();

  const originalReplyWithHTML = ctx.replyWithHTML.bind(ctx);
  ctx.replyWithHTML = async (htmlText, extra) => {
    const response = await originalReplyWithHTML(htmlText, extra);
    await funReactions.maybeSendFunReaction(ctx, htmlText);
    return response;
  };

  await next();
});

// ===== Combo delete: user message + previous bot message =====
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();
  if (!ctx.message?.text) return next();
  if (ctx.message?.forward_from || ctx.message?.forward_from_chat)
    return next();

  const id = ctx.from.id;

  try {
    await ctx.deleteMessage();
  } catch {}

  const last = replyManager.getLastBotMessage(id);
  if (last && !last.hasKeyboard) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, last.msgId);
    } catch {}
  }

  await next();
});

// ===== Safe reply helper: auto-menu + fun reaction + combo tracking =====
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();

  ctx.sendBotReply = async (htmlText, extra) => {
    let finalExtra = extra;
    const id = ctx.from.id;
    const hasRemove = extra?.reply_markup?.remove_keyboard;
    const hasOwnKeyboard =
      extra?.reply_markup?.keyboard || extra?.reply_markup?.inline_keyboard;
    if (!hasRemove && !hasOwnKeyboard) {
      const menuMarkup = getMenuForRole(id);
      if (menuMarkup?.reply_markup) {
        const extraRM = extra?.reply_markup || {};
        finalExtra = {
          ...(extra || {}),
          reply_markup: { ...extraRM, ...menuMarkup.reply_markup },
        };
      }
    }
    const msg = await ctx.replyWithHTML(htmlText, finalExtra);
    const hasKeyboard = !!finalExtra?.reply_markup?.keyboard;
    replyManager.setLastBotMessage(id, msg.message_id, hasKeyboard);
    return msg;
  };

  await next();
});

// Helper: send loading message that gets edited to final result.
// Returns a finalize(text, extra) function that updates the message
// and fixes combo-delete tracking.
async function sendLoadingMessage(ctx, loadingText) {
  // Capture old reply message to replace after state change
  const oldLast = replyManager.getLastBotMessage(ctx.from.id);
  const oldReplyMsgId = oldLast && oldLast.hasKeyboard ? oldLast.msgId : null;

  const msg = await ctx.telegram.sendMessage(ctx.chat.id, loadingText, {
    parse_mode: "HTML",
  });
  return async function finalize(text, extra = {}) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      text,
      { parse_mode: "HTML", ...extra },
    );
    const hasKeyboard = !!(
      extra.reply_markup?.keyboard || extra.reply_markup?.inline_keyboard
    );
    replyManager.setLastBotMessage(ctx.from.id, msg.message_id, hasKeyboard);

    // Replace old reply message with updated keyboard via sticker or dot
    if (oldReplyMsgId) {
      await ctx.telegram
        .deleteMessage(ctx.chat.id, oldReplyMsgId)
        .catch(() => {});
    }
  };
}

// Helper: replace previous bot message with new content.
// Used for navigation (settings, profile, back, etc.) to avoid stacking messages.
// Edits the last message if possible; otherwise deletes old + sends new.
async function replaceMessage(ctx, text, extra) {
  const last = replyManager.getLastBotMessage(ctx.from.id);
  const hasText = !!(text && String(text).trim());
  const rp = extra?.reply_markup;
  // Same keyboard type: inline→inline or reply→reply — edit in place
  const sameKeyboardType = !rp || !!last?.hasKeyboard === !!rp.keyboard;

  if (last?.msgId && sameKeyboardType) {
    try {
      if (hasText) {
        const opts = { parse_mode: "HTML", ...(extra || {}) };
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          last.msgId,
          undefined,
          text,
          opts,
        );
        replyManager.setLastBotMessage(ctx.from.id, last.msgId, !!rp?.keyboard);
      } else if (rp) {
        await ctx.telegram.editMessageReplyMarkup(
          ctx.chat.id,
          last.msgId,
          undefined,
          rp,
        );
      }
      return;
    } catch (e) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, last.msgId);
      } catch {}
    }
  }

  // Different keyboard type or can't edit — delete old + send new
  if (last?.msgId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, last.msgId);
    } catch {}
  }
  if (hasText || rp) {
    const displayText = hasText ? text : "•";
    const msg = await ctx.telegram.sendMessage(ctx.chat.id, displayText, {
      parse_mode: "HTML",
      ...(extra || {}),
    });
    replyManager.setLastBotMessage(ctx.from.id, msg.message_id, !!rp?.keyboard);
  }
}

// Helper: silently update reply keyboard after state changes.
// Uses zero-width space so the message is invisible.
function updateReplyKeyboard(ctx) {
  const menu = getMenuForRole(ctx.from.id);
  if (!menu?.reply_markup) return;
  ctx.telegram
    .sendMessage(ctx.chat.id, "\u200B", {
      disable_notification: true,
      reply_markup: menu.reply_markup,
    })
    .catch(() => {});
}

// Helper: sync shift status from Google Sheets to local DB.
// Runs on /refresh to detect manual sheet edits.
async function syncShiftStatus(ctx) {
  const id = ctx.from.id;
  const fio = getUserField(id, "fio");
  const workplace = getUserField(id, "workplace");
  if (!fio || !workplace) return;

  const courier = await findCourierInAllSheets(fio);
  if (!courier) return;

  const config = getSheetConfig(workplace);
  const tz = process.env.APP_TIMEZONE || "Europe/Moscow";
  const { day } = getCurrentDateInfo(tz);

  // Sync time
  const timeCols = getCourierColumnsByDay(day);
  const [from, to] = await Promise.all([
    readCell(
      config.courierSheet,
      `${getColumnLetter(timeCols.startColumn)}${courier.row}`,
      courier.spreadsheetId,
    ),
    readCell(
      config.courierSheet,
      `${getColumnLetter(timeCols.endColumn)}${courier.row}`,
      courier.spreadsheetId,
    ),
  ]);
  const fromOk = !isEmptyCell(from) && !isScheduleMarker(from);
  const toOk = !isEmptyCell(to) && !isScheduleMarker(to);
  if (fromOk && toOk) setShiftStatus(id, "time", "both");
  else if (fromOk) setShiftStatus(id, "time", "start");
  else if (toOk) setShiftStatus(id, "time", "end");
  else setShiftStatus(id, "time", "none");

  // Sync mileage
  const courierType = getUserField(id, "courierType") || "auto";
  if (courierType !== "pedestrian") {
    // Find mileage row by FIO
    const mileageRows = await getValues(
      `${config.mileageSheet}!${config.mileageFioRange}`,
      courier.spreadsheetId,
    );
    let mileageRow = null;
    const target = normalizeFio(fio);
    for (let i = 0; i < mileageRows.length; i += 1) {
      const row = mileageRows[i];
      const rowFio = (row[row.length - 1] || "").toString().trim();
      if (normalizeFio(rowFio) === target) {
        mileageRow = i + 3;
        break;
      }
    }
    if (mileageRow) {
      const mCols = getMileageColumnsByDay(day);
      const [ms, me] = await Promise.all([
        readCell(
          config.mileageSheet,
          `${getColumnLetter(mCols.startColumn)}${mileageRow}`,
          courier.spreadsheetId,
        ),
        readCell(
          config.mileageSheet,
          `${getColumnLetter(mCols.endColumn)}${mileageRow}`,
          courier.spreadsheetId,
        ),
      ]);
      const msOk = !isEmptyCell(ms) && !isScheduleMarker(ms);
      const meOk = !isEmptyCell(me) && !isScheduleMarker(me);
      if (msOk && meOk) setShiftStatus(id, "mileage", "both");
      else if (msOk) setShiftStatus(id, "mileage", "start");
      else if (meOk) setShiftStatus(id, "mileage", "end");
      else setShiftStatus(id, "mileage", "none");
    }
  }
}

bot.on("sticker", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const sticker = ctx.message?.sticker;
  if (!sticker?.file_id) return;

  const reactionType = funReactions.getStickerReactionTypeByEmoji(
    sticker.emoji,
  );
  const saved = funReactions.saveFunSticker(sticker.file_id, reactionType);

  if (saved) {
    safeLog.log("fun sticker saved", reactionType, sticker.file_id);
  }

  if (sticker.set_name) {
    await funReactions.importStickerSetForFunReactions(ctx, sticker.set_name);
  }
});

bot.on("animation", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const animation = ctx.message?.animation;
  if (!animation?.file_id) return;

  const saved = funReactions.saveFunGif(animation.file_id, "neutral");
  if (saved) {
    safeLog.log("fun gif saved", animation.file_id);
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
    workplace: state?.workplace || null,
  });
}

function getNextRouteSheetNumber(state, date) {
  try {
    if (!fs.existsSync(routeSheetLogPath)) {
      return 1;
    }

    const lines = fs
      .readFileSync(routeSheetLogPath, "utf8")
      .split("\n")
      .filter(Boolean);
    const count = lines.reduce((total, line) => {
      try {
        const entry = JSON.parse(line);
        return entry.date === date && entry.fio === state?.fio
          ? total + 1
          : total;
      } catch (_) {
        return total;
      }
    }, 0);

    return count + 1;
  } catch (error) {
    safeLog.error("route sheet count error", error);
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
    workplace: state?.workplace || null,
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
    label,
  });
}

function formatMoneyRu(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return "0,00 ₽";
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
  return `${formatted} ₽`;
}

function formatMoneyRuNumber(value) {
  const withCurrency = formatMoneyRu(value);
  if (!withCurrency) return null;
  return withCurrency.replace(/\s*₽$/, "");
}

const MAX_REASONABLE_CASH_AMOUNT = 500000;

function makeMileageState(telegramId, baseState, extra = {}) {
  return {
    telegramId,
    ...baseState,
    awaitingMileagePhoto: true,
    awaitingManualMileage: false,
    photoReceived: false,
    ...extra,
  };
}

function normalizeCarNumber(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function isValidCarNumber(value) {
  const normalized = normalizeCarNumber(value);
  if (!normalized) return false;
  if (normalized.length < 4 || normalized.length > 12) return false;
  return /[А-ЯЁA-Z]/.test(normalized) && /\d/.test(normalized);
}

function normalizeTimeValue(value) {
  const text = String(value || "").trim();

  // 1) Двоеточие — всегда время (пробелы вокруг ":" игнорируем)
  const noSpaces = text.replace(/\s+/g, "");
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
  return (
    [
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
      "Время смены",
      "Внести время смены",
      "Время",
      "Внести пробег",
      "Пробег",
      "Маршрутный лист",
      "Маршрутник",
      "Сверки",
      "Деньги к сдаче",
      "Наличные",
      "Проблема с заказом",
      "Проблема",
      "Лидерборд",
      "Настройки",
      "Помощь",
      "Профиль",
      "Изменить номер машины",
      "Номер машины",
      "Поменять магазин",
      "Изменить интернет-магазин",
      "Магазин",
      "Изменить устройство",
      "Устройство",
      "Поменять сотрудника",
      "Сменить сотрудника",
      "Сотрудник",
      "Таблицы",
      "Мой ID",
    ].includes(text) ||
    WORKPLACES.includes(text) ||
    DEVICES.includes(text)
  );
}

async function askForCarNumber(ctx, fio = getUserField(ctx.from.id, "fio")) {
  setState(ctx.from.id, { awaitingCarNumber: true, fio });
  await ctx.replyWithHTML(
    `🚗 <b>Номер машины</b>\n\nВведите гос. номер автомобиля.\nНапример: <code>А123ВС777</code>`,
    Markup.removeKeyboard(),
  );
}

async function askForWorkplace(ctx, fio = getUserField(ctx.from.id, "fio")) {
  setState(ctx.from.id, { awaitingWorkplace: true, fio });
  await ctx.replyWithHTML(
    "🏬 <b>Интернет-магазин</b>\n\nВыберите ваш магазин:",
    workplaceMenu(),
  );
}

async function askForDevice(ctx, fio = getUserField(ctx.from.id, "fio")) {
  setState(ctx.from.id, { awaitingDevice: true, fio });
  await ctx.replyWithHTML(
    "💻 <b>Рабочее устройство</b>\n\nВыберите устройство:",
    deviceMenu(),
  );
}

async function saveCarNumber(ctx, value) {
  const carNumber = normalizeCarNumber(value);

  if (!carNumber || isMenuText(value)) {
    await ctx.replyWithHTML(
      "❌ Введите номер машины текстом.\nНапример: <code>А123ВС777</code>",
    );
    return "error";
  }

  if (!isValidCarNumber(carNumber)) {
    await ctx.replyWithHTML(
      "❌ Неверный формат номера.\nНомер должен содержать буквы и цифры.\nНапример: <code>А123ВС777</code>",
    );
    return "error";
  }

  setUserField(ctx.from.id, "carNumber", carNumber);
  safeLog.log("номер машины сохранён");

  if (!getUserField(ctx.from.id, "workplace")) {
    await ctx.replyWithHTML(
      `✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`,
    );
    await askForWorkplace(ctx);
    return "askWorkplace";
  }

  if (!getUserField(ctx.from.id, "device")) {
    await ctx.replyWithHTML(
      `✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`,
    );
    await askForDevice(ctx);
    return "askDevice";
  }

  clearState(ctx.from.id);
  await ctx.replyWithHTML(
    `✅ Номер машины сохранён: <code>${esc(carNumber)}</code>`,
  );
  return "done";
}

async function saveWorkplace(ctx, value) {
  const workplace = WORKPLACES.find(
    (item) =>
      item.toLowerCase() ===
      String(value || "")
        .trim()
        .toLowerCase(),
  );

  if (!workplace) {
    await ctx.replyWithHTML(
      "❌ Выберите магазин кнопкой ниже.",
      workplaceMenu(),
    );
    return "error";
  }

  setUserField(ctx.from.id, "workplace", workplace);
  safeLog.log("интернет-магазин сохранён");
  const role = getUserRole(ctx.from.id);

  if (role === "logist") {
    clearState(ctx.from.id);
    await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`);
    return "done";
  }

  if (!getUserField(ctx.from.id, "device")) {
    await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`);
    await askForDevice(ctx);
    return "askDevice";
  }

  clearState(ctx.from.id);
  await ctx.replyWithHTML(`✅ Магазин сохранён: <b>${esc(workplace)}</b>`);
  return "done";
}

async function saveDevice(ctx, value) {
  const device = DEVICES.find(
    (item) =>
      item.toLowerCase() ===
      String(value || "")
        .trim()
        .toLowerCase(),
  );

  if (!device) {
    await ctx.replyWithHTML(
      "❌ Выберите устройство кнопкой ниже.",
      deviceMenu(),
    );
    return "error";
  }

  setUserField(ctx.from.id, "device", device);
  clearState(ctx.from.id);
  safeLog.log("устройство сохранено");
  await ctx.replyWithHTML(`✅ Устройство сохранено: <b>${esc(device)}</b>`);
  return "done";
}

async function ensureProfile(ctx) {
  const profile = getFullProfile(ctx.from.id);
  const role = getUserRole(ctx.from.id);

  if (!profile.fio) {
    await askForFio(ctx);
    return null;
  }

  if (role !== "logist") {
    if (profile.courierType !== "pedestrian" && !profile.carNumber) {
      await askForCarNumber(ctx, profile.fio);
      return null;
    }
  }

  if (!profile.workplace) {
    await askForWorkplace(ctx, profile.fio);
    return null;
  }

  if (role !== "logist") {
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
  return {
    ...applyCarNumber(result, profile.carNumber),
    workplace: profile.workplace,
    device: profile.device,
  };
}

async function askForFio(ctx) {
  const telegramId = ctx.from.id;
  setState(telegramId, { awaitingFio: true });
  await ctx.replyWithHTML(
    "👤 <b>Авторизация</b>\n\nВведите имя и фамилию как в таблице.",
    Markup.keyboard([[BUTTONS.back]]).resize(),
  );
}

async function authorizeFio(ctx, fio) {
  const telegramId = ctx.from.id;

  try {
    safeLog.log("авторизация ФИО");
    const finalize = await sendLoadingMessage(
      ctx,
      "🔍 Ищу сотрудника в таблице...",
    );
    const employee = await findCourierInAllSheets(fio);

    if (!employee) {
      safeLog.log("сотрудник не найден");
      await finalize(
        "❌ Сотрудник не найден в таблице.\nПроверьте имя и фамилию и попробуйте ещё раз.",
      );
      return;
    }

    setUserField(telegramId, "fio", employee.fio);
    safeLog.log("сотрудник найден");
    await finalize(`✅ Сотрудник найден: <b>${esc(employee.fio)}</b>`);

    const auto = String(employee.auto || "")
      .trim()
      .toLowerCase();
    const workplace = employee.workplace;

    if (workplace === "ИМ Центр") {
      if (auto === "пеший") {
        setUserField(telegramId, "courierType", "pedestrian");
        setUserField(telegramId, "role", "courier");
        setUserField(telegramId, "workplace", "ИМ Центр");
        await ctx.replyWithHTML(
          "🚶 <b>Пеший курьер</b>, магазин <b>ИМ Центр</b>.",
        );
        await askForDevice(ctx, employee.fio);
        return;
      }
      if (auto === "логист") {
        setUserField(telegramId, "role", "logist");
        await ctx.replyWithHTML(
          "📦 <b>Логист</b>.\n\nТеперь выберите ваш магазин.",
          logistMainMenu(telegramId),
        );
        await askForWorkplace(ctx, employee.fio);
        return;
      }
      setUserField(telegramId, "courierType", "auto");
      setUserField(telegramId, "role", "courier");
      await ctx.replyWithHTML(
        "🚗 <b>Авто-курьер</b>.\n\nТеперь введите номер машины.",
      );
      await askForCarNumber(ctx, employee.fio);
      return;
    }

    if (workplace === "ИМ Восток") {
      if (auto === "логист") {
        setUserField(telegramId, "role", "logist");
        await ctx.replyWithHTML(
          "📦 <b>Логист</b>.\n\nТеперь выберите ваш магазин.",
          logistMainMenu(telegramId),
        );
        await askForWorkplace(ctx, employee.fio);
        return;
      }
      setState(telegramId, {
        awaitingRoleChoice: true,
        fio: employee.fio,
        workplace: employee.workplace,
      });
      await ctx.replyWithHTML(
        "👤 <b>Выберите вашу роль:</b>\n\n" +
          "▫️ <b>Курьер</b> — доставка заказов, пробег, маршрутник, сверка, наличные\n" +
          "▫️ <b>Логист</b> — учёт времени, сбор наличных с курьеров, таблицы",
        roleChoiceKeyboard(),
      );
      return;
    }

    setState(telegramId, {
      awaitingRoleChoice: true,
      fio: employee.fio,
      workplace: employee.workplace,
    });
    await ctx.replyWithHTML(
      "👤 <b>Выберите вашу роль:</b>\n\n" +
        "▫️ <b>Курьер</b> — доставка заказов, пробег, маршрутник, сверка, наличные\n" +
        "▫️ <b>Логист</b> — учёт времени, сбор наличных с курьеров, таблицы",
      roleChoiceKeyboard(),
    );
  } catch (error) {
    safeLog.error("ошибка Google Sheets", error);
    await ctx.replyWithHTML(
      "⚠️ Ошибка Google Таблицы.\nПопробуйте ещё раз или обратитесь к администратору.",
    );
  }
}

async function punchTimeFlow(ctx, explicitStage = null) {
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return;
  }

  try {
    const finalize = await sendLoadingMessage(ctx, "⏳ Записываю время...");
    const isPedestrian = profile.courierType === "pedestrian";
    let result;
    if (explicitStage) {
      result = await replaceTime(
        profile.fio,
        profile.workplace,
        explicitStage,
        isPedestrian,
      );
    } else {
      result = await punchTime(profile.fio, profile.workplace, isPedestrian);
    }

    if (result.notFound) {
      const msg = formatNoSheetMessage(result, profile.workplace);
      await finalize(msg);
      return;
    }

    if (result.needsReplaceChoice) {
      safeLog.log("нужна замена");
      setState(telegramId, { awaitingReplaceChoice: true, fio: profile.fio });
      await finalize(
        `⚠️ Время уже записано\n` +
          `──────────────\n\n` +
          `🟢 Старт: <code>${esc(result.from)}</code>\n` +
          `🔴 Конец: <code>${esc(result.to)}</code>\n\n` +
          `Что заменить?`,
        { reply_markup: replaceKeyboard().reply_markup },
      );
      return;
    }

    safeLog.log("время записано", result.stage);
    const currentTimeStatus = getShiftStatus(telegramId, "time");
    if (result.stage === "start") {
      setShiftStatus(
        telegramId,
        "time",
        currentTimeStatus === "end" || currentTimeStatus === "both"
          ? "both"
          : "start",
      );
    } else {
      setShiftStatus(
        telegramId,
        "time",
        currentTimeStatus === "start" || currentTimeStatus === "both"
          ? "both"
          : "end",
      );
    }

    if (result.stage === "start" && currentTimeStatus === "none") {
      const cur = Number(getUserField(telegramId, "shiftCount") || 0);
      setUserField(telegramId, "shiftCount", cur + 1);
    }

    const icon = result.stage === "start" ? "🟢" : "🔴";
    const label = result.stage === "start" ? "Старт" : "Конец";

    setState(telegramId, {
      awaitingTimeChange: true,
      awaitingManualTime: false,
      fio: result.fio,
      courierRow: result.courierRow,
      day: result.day,
      stage: result.stage,
      timeValue: result.timeValue,
      workplace: profile.workplace,
    });

    await finalize(
      `${icon} <b>${label} смены</b>\n` +
        `──────────────\n\n` +
        `⏰ <code>${esc(result.timeValue)}</code>\n\n` +
        `📝 Неверно? → «Изменить время»`,
      { reply_markup: timeChangeKeyboard().reply_markup },
    );

    // Обновляем reply-клавиатуру: кнопка времени должна сразу сменить подпись
    // (Старт → Конец → Заменить). Тот же приём, что в saveMileageFromState.
    if (ctx.chat?.id) {
      const menu = getMenuForRole(telegramId);
      if (menu?.reply_markup) {
        await funReactions.sendFunReaction(ctx, "success", menu.reply_markup);
      }
    }

    if (result.stage === "start") {
      const pendingCash = getPendingCash(telegramId);
      const pendingAmount = Number(pendingCash?.amount || 0);

      if (Number.isFinite(pendingAmount) && pendingAmount >= 1) {
        const formattedAmount =
          pendingCash?.formatted || formatMoneyRu(pendingAmount);
        const numberOnly =
          formatMoneyRuNumber(pendingAmount) ||
          String(formattedAmount || "").replace(/\s*₽$/, "");
        await ctx.replyWithHTML(
          `⚠️ Не забудьте сдать деньги\n` +
            `──────────────\n\n` +
            `💰 Сумма: <code>${esc(numberOnly)}</code> ₽\n` +
            `🏬 Магазин: <b>${esc(pendingCash?.workplace || profile.workplace || "не указано")}</b>`,
          cashSubmitConfirmKeyboard(),
        );
      }
    }
  } catch (error) {
    safeLog.error("ошибка Google Sheets", error);
    await ctx.replyWithHTML(
      "⚠️ Не удалось записать время\n\nПопробуйте ещё раз.",
    );
  }
}

async function mileageFlow(ctx, explicitStage = null) {
  if (isLogist(ctx.from.id)) {
    return { status: "access_denied" };
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: "no_profile" };
  }

  if (profile.courierType === "pedestrian") {
    return { status: "pedestrian_no_mileage" };
  }

  try {
    const finalize = await sendLoadingMessage(
      ctx,
      "⏳ Проверяю данные пробега...",
    );
    const result = await prepareMileage(
      profile.fio,
      profile.workplace,
      explicitStage,
    );

    if (result.notFound) {
      const msg = formatNoSheetMessage(result, profile.workplace);
      await finalize(msg);
      return { status: "not_found" };
    }

    if (result.needsReplaceChoice) {
      safeLog.log("нужна замена пробега");
      setState(telegramId, {
        awaitingMileageReplaceChoice: true,
        fio: profile.fio,
      });
      await finalize(
        `⚠️ Пробег уже записан\n` +
          `──────────────\n\n` +
          `🟢 Старт: <code>${esc(result.startMileage)}</code>\n` +
          `🔴 Конец: <code>${esc(result.endMileage)}</code>\n\n` +
          `Что заменить?`,
        { reply_markup: mileageReplaceKeyboard().reply_markup },
      );
      return { status: "needs_replace_choice" };
    }

    setState(
      telegramId,
      makeMileageState(telegramId, applyProfile(result, profile), {
        source: "mileage",
      }),
    );
    safeLog.log("ожидание пробега", result.stage);
    await finalize(
      `📸 Пробег — <b>${esc(formatStage(result.stage))}</b>\n` +
        `──────────────\n\n` +
        `📷 Отправьте фото одометра\n\n` +
        `📎 Скрепка → 📷 Камера или 🖼 Галерея`,
      { reply_markup: skipMileageKeyboard().reply_markup },
    );
    return { status: "awaiting_photo" };
  } catch (error) {
    safeLog.error("ошибка Google Sheets", error);
    return { status: "error" };
  }
}

async function routeSheetFlow(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: "access_denied" };
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: "no_profile" };
  }

  setState(telegramId, {
    awaitingRouteSheetPhoto: true,
    fio: profile.fio,
    carNumber: profile.carNumber,
    workplace: profile.workplace,
  });

  await ctx.replyWithHTML(
    `📄 Маршрутный лист\n` +
      `──────────────\n\n` +
      `📷 Отправьте фото документа\n` +
      `📎 Можно отправить несколько подряд\n\n` +
      `📎 Скрепка → 📷 Камера или 🖼 Галерея`,
    routeSheetKeyboard(),
  );
  return { status: "awaiting_photo" };
}

async function reconciliationFlow(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: "access_denied" };
  }
  const telegramId = ctx.from.id;
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: "no_profile" };
  }

  const isTerminal = profile.device === "Терминал";
  const totalPhotos = isTerminal ? 2 : 1;

  setState(telegramId, {
    awaitingReconciliationPhoto: true,
    reconciliationPhotosSent: 0,
    reconciliationTotal: totalPhotos,
    fio: profile.fio,
    carNumber: profile.carNumber,
    workplace: profile.workplace,
    device: profile.device,
  });

  const firstLabel = isTerminal ? "📊 Статистика" : "Пин-Панель";
  const orderHint = isTerminal
    ? "<b>Порядок:</b> сначала скриншот статистики, потом чек."
    : "";

  const lines = [
    `📊 Сверка\n`,
    `──────────────\n`,
    `📷 Фото <b>1 из ${totalPhotos}</b>: ${firstLabel}`,
  ];
  if (orderHint) {
    lines.push("");
    lines.push(`💡 ${orderHint}`);
  }
  lines.push("");
  lines.push("📎 Скрепка → 📷 Камера или 🖼 Галерея");

  await ctx.replyWithHTML(lines.join("\n"), routeSheetKeyboard());
  return { status: "awaiting_photo" };
}

async function showPendingCashStatus(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: "access_denied" };
  }
  const profile = await ensureProfile(ctx);
  if (!profile) return { status: "no_profile" };

  const pendingCash = getPendingCash(ctx.from.id);
  const amount = Number(pendingCash?.amount || 0);

  if (!Number.isFinite(amount) || amount < 1) {
    return { status: "no_debt" };
  }

  if (pendingCash?.confirmationStatus === "awaiting") {
    return { status: "already_submitted" };
  }

  const formatted = pendingCash?.formatted || formatMoneyRu(amount);
  const numberOnly =
    formatMoneyRuNumber(amount) || String(formatted || "").replace(/\s*₽$/, "");
  const workplace = pendingCash?.workplace || profile.workplace || "не указано";
  const fun = String(process.env.FUN_TONE || "").toLowerCase() === "true";
  const lines = [
    `💵 Сдача наличных\n`,
    `──────────────\n`,
    `💰 Сумма: <code>${esc(numberOnly)}</code> ₽`,
    `🏬 Магазин: <b>${esc(workplace)}</b>`,
    "",
  ];
  if (fun) lines.push("😼 Ай-ай, денюжки надо сдать!", "");
  lines.push("Сдали деньги в кассу?");
  await ctx.replyWithHTML(lines.join("\n"), cashSubmitConfirmKeyboard());
  return { status: "showing_pending" };
}

async function sendHelp(ctx) {
  const role = getUserRole(ctx.from.id);

  if (role === "logist") {
    const workplace = getUserField(ctx.from.id, "workplace");
    const features = WORKPLACE_FEATURES[workplace] || {};
    const hasCash = features.cashCollection;
    let logistHelp =
      "❓ <b>Помощь</b>\n" +
      "───────────────\n\n" +
      `1️⃣ <b>Записать время</b> — «${BUTTONS.punchTime}» отметить начало или конец смены.\n` +
      `2️⃣ <b>Открыть ИМ</b> — «${BUTTONS.openShop}» отправить уведомление об открытии магазина в группу.\n`;
    if (hasCash) {
      logistHelp += `3️⃣ <b>Принять наличные</b> — «${BUTTONS.cashCollect}» посмотреть должников и отправить напоминание.\n`;
      logistHelp += `4️⃣ <b>История сборов</b> — «${BUTTONS.cashHistory}» просмотр истории по датам.\n`;
    }
    logistHelp += `${hasCash ? "5️⃣" : "3️⃣"} <b>Таблицы</b> — «${BUTTONS.sheetInfo}» информация о привязке таблиц.\n`;
    logistHelp += `${hasCash ? "6️⃣" : "4️⃣"} <b>Настройки</b> — «${BUTTONS.settings}» магазин, смена сотрудника.\n\n`;
    logistHelp += "📋 Команды:";
    await ctx.replyWithHTML(
      logistHelp,
      Markup.inlineKeyboard([
        [styledButton("📋 Команды", "help_commands", "primary")],
        [styledButton("❌ Закрыть", "close_message", "danger")],
      ]),
    );
    return;
  }

  await ctx.replyWithHTML(
    "❓ <b>Помощь</b>\n" +
      "───────────────\n\n" +
      "1️⃣ <b>Первый вход</b> — введите ФИО, номер машины, магазин и устройство.\n" +
      `2️⃣ <b>Записать время</b> — «${BUTTONS.punchTime}» отметить начало или конец смены.\n` +
      `3️⃣ <b>Фото пробега</b> — «${BUTTONS.mileage}» отправьте фото одометра или введите вручную.\n` +
      "   • «📷 Загрузить фото повторно» или «✏️ Ввести вручную» если не распозналось.\n" +
      `4️⃣ <b>Отправить маршрутник</b> — «${BUTTONS.routeSheet}» отправить фото маршрутного листа.\n` +
      `5️⃣ <b>Отправить сверку</b> — «${BUTTONS.reconciliation}» Терминал — 2 фото, Пин-Панель — 1 фото.\n` +
      `6️⃣ <b>Сдать наличные</b> — «${BUTTONS.cashCheck}» показать сумму к сдаче и подтвердить.\n` +
      `7️⃣ <b>Проблема с заказом</b> — «${BUTTONS.issues}» ссылки для решения проблем с заказами.\n` +
      `8️⃣ <b>Настройки</b> — «${BUTTONS.settings}» номер машины, магазин, устройство, сотрудник.\n\n` +
      "📋 Команды:",
    Markup.inlineKeyboard([
      [styledButton("📋 Команды", "help_commands", "primary")],
      [styledButton("❌ Закрыть", "close_message", "danger")],
    ]),
  );
}

async function sendCommandsList(ctx) {
  const isAdmin = isAdminUser(ctx.from.id);
  const role = getUserRole(ctx.from.id);
  let msg =
    "📋 <b>Команды</b>\n" +
    "───────────────\n\n" +
    "<b>Основные:</b>\n" +
    "/help — помощь\n" +
    "/cancel — отмена текущего действия\n\n";

  if (role !== "logist") {
    msg +=
      "<b>Настройки:</b>\n" +
      "/car — сменить номер машины\n" +
      "/workplace — сменить магазин\n" +
      "/device — сменить устройство\n\n";
  } else {
    msg += "<b>Настройки:</b>\n" + "/workplace — сменить магазин\n\n";
  }

  if (isAdmin) {
    msg +=
      "<b>Администратору:</b>\n" +
      "/chatid — информация о чате\n" +
      "/sheet — привязка таблиц\n" +
      "/sheet_access — доступ к «📋 Таблицы»\n" +
      "  <code>/sheet_access</code> — показать список\n" +
      "  <code>/sheet_access 123456789</code> — дать доступ\n" +
      "  <code>/sheet_access - 123456789</code> — убрать доступ\n" +
      "/role — сменить роль пользователя\n\n";
  }

  if (role === "logist") {
    msg +=
      "<b>Кнопки меню:</b>\n" +
      `⏱ <b>Время</b> — записать старт/конец\n` +
      `💳 <b>Наличные</b> — посмотреть должников, отправить напоминание\n` +
      `📋 <b>Таблицы</b> — информация о привязке таблиц\n` +
      `⚙️ <b>Настройки</b> — магазин, сотрудник`;
  } else {
    msg +=
      "<b>Кнопки меню:</b>\n" +
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
  const raw = String(process.env.UPDATE_NOTES || "").trim();
  if (!raw) return [];

  return raw
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function buildUpdateHighlights(changedFiles = [], version, updates = []) {
  const files = new Set(
    (changedFiles || []).map((file) => String(file || "").toLowerCase()),
  );
  const includesAny = (targets) =>
    targets.some((target) => files.has(target.toLowerCase()));
  const highlights = [];

  if (includesAny(["gemini_ocr_server.py"])) {
    highlights.push(
      "📸 Полностью обновлён движок OCR: Gemini 2.5 Flash Lite распознаёт и пробег, и сверки.",
    );
  }

  if (includesAny(["bot.js"])) {
    highlights.push("🤖 Обновлена логика бота, улучшена стабильность.");
  }

  if (includesAny(["ecosystem.config.js"])) {
    highlights.push("⚙️ Обновлены настройки запуска.");
  }

  if (includesAny(["sheetcommand.js", "googlesheets.js", "storage.js"])) {
    highlights.push("🗂 Улучшена работа с таблицами.");
  }

  if (includesAny(["mileageocr.js"])) {
    highlights.push("📸 Улучшено распознавание пробега.");
  }

  if (includesAny(["achievements.js", "xp.js", "challenges.js", "streak.js"])) {
    highlights.push("🏆 Обновлена система достижений и рейтинга.");
  }

  if (
    includesAny([
      "courier.js",
      "logist.js",
      "commands.js",
      "admin.js",
      "textrouter.js",
      "replyforwarding.js",
    ])
  ) {
    highlights.push("💬 Обновлены сценарии общения с ботом.");
  }

  if (includesAny(["utils.js"])) {
    highlights.push("🧮 Обновлены вспомогательные функции.");
  }

  if (highlights.length === 0) {
    highlights.push("✨ Небольшие улучшения стабильности и удобства.");
  }

  // Добавляем 1-2 git-коммита как детали (если есть)
  if (Array.isArray(updates) && updates.length > 0) {
    const details = updates.slice(0, 3).map((u) => `• ${u}`);
    return { highlights: highlights.slice(0, 4), details };
  }

  return { highlights: highlights.slice(0, 4), details: [] };
}

function formatUpdateMessage(version, changedFiles = [], updates = []) {
  const { highlights, details } = buildUpdateHighlights(
    changedFiles,
    version,
    updates,
  );
  const lines = highlights.map((item) => `• ${esc(item)}`).join("\n");

  let detailsBlock = "";
  if (details.length > 0) {
    detailsBlock = "\n\n<b>Подробности:</b>\n" + details.join("\n");
  }

  return (
    `🆕 <b><i>Обновление бота v${esc(version)}</i></b>\n\n` +
    "<b>Коротко, что изменили:</b>\n" +
    `${lines}${detailsBlock}\n\n` +
    "💙 Хорошей смены!"
  );
}

async function notifyUsersAboutUpdate(
  version,
  changedFiles = [],
  updates = [],
) {
  const currentVersion = version || getVersion();
  const userIds = getAllUserIds();
  let notified = 0;
  let skipped = 0;
  let failed = 0;

  const message = formatUpdateMessage(currentVersion, changedFiles, updates);

  for (const telegramId of userIds) {
    const lastVersion = getUserField(telegramId, "version");
    if (lastVersion === currentVersion) {
      skipped++;
      continue;
    }

    try {
      await withTimeout(
        bot.telegram.sendMessage(Number(telegramId), message, {
          parse_mode: "HTML",
          disable_notification: true,
        }),
        10000,
        "update notify",
      );
      setUserField(telegramId, "version", currentVersion);
      notified++;
    } catch (error) {
      safeLog.error("update notify error", error.message);
      failed++;
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  safeLog.log(
    `update v${currentVersion} notify summary: total=${userIds.length}, sent=${notified}, skipped=${skipped}, failed=${failed}`,
  );
}

async function refreshAllKeyboards() {
  const userIds = getAllUserIds();
  let sent = 0;
  let failed = 0;

  for (const telegramId of userIds) {
    try {
      const menuMarkup = getMenuForRole(Number(telegramId));
      if (!menuMarkup?.reply_markup) continue;
      const msg = await bot.telegram.sendMessage(Number(telegramId), ".", {
        disable_notification: true,
        reply_markup: menuMarkup.reply_markup,
      });
      await new Promise((r) => setTimeout(r, 200));
      await bot.telegram
        .deleteMessage(Number(telegramId), msg.message_id)
        .catch((e) => {
          safeLog.error(
            "keyboard refresh delete failed for",
            telegramId,
            e.message,
          );
        });
      sent++;
    } catch (error) {
      safeLog.error("keyboard refresh error for", telegramId, error.message);
      failed++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  safeLog.log(
    `keyboard refresh summary: total=${userIds.length}, sent=${sent}, failed=${failed}`,
  );
}

const _pendingUpdates = {};
const PENDING_UPDATES_FILE = path.join(__dirname, "pending_updates.json");

function loadPendingUpdates() {
  try {
    if (fs.existsSync(PENDING_UPDATES_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_UPDATES_FILE, "utf8"));
      Object.assign(_pendingUpdates, data);
      safeLog.log("loaded pending updates", Object.keys(data));
    }
  } catch (e) {
    safeLog.error("failed to load pending updates", e.message);
  }
}

function savePendingUpdates() {
  try {
    fs.writeFileSync(
      PENDING_UPDATES_FILE,
      JSON.stringify(_pendingUpdates, null, 2),
    );
  } catch (e) {
    safeLog.error("failed to save pending updates", e.message);
  }
}

loadPendingUpdates();

async function askAdminsAboutUpdate(version, changedFiles = [], updates = []) {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    safeLog.log("no admin IDs configured, skipping update approval");
    return;
  }

  const message = formatUpdateMessage(version, changedFiles, updates);
  const previewText =
    `🔔 <b>Обнаружено обновление v${esc(version)}</b>\n\n` +
    "<b>Предпросмотр сообщения:</b>\n\n" +
    `${message}\n\n` +
    "Отправить уведомление всем пользователям?";

  const keyboard = Markup.inlineKeyboard([
    [
      styledButton("✅ Отправить", `upd_send:${version}`, "success"),
      styledButton("✏️ Изменить текст", `upd_edit:${version}`, "primary"),
    ],
    [styledButton("⏭️ Пропустить", `upd_skip:${version}`)],
  ]);

  _pendingUpdates[version] = { changedFiles, updates, message };
  savePendingUpdates();

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, previewText, {
        parse_mode: "HTML",
        ...keyboard,
      });
    } catch (error) {
      safeLog.error("admin update ask error", adminId, error.message);
    }
  }
}

async function saveMileageFromState(ctx, mileage, options = {}) {
  const { sourceBuffer, telegram, chatId, expectedFileId, fallbackState } =
    options;
  const replyFn = ctx.replyWithHTML
    ? (html, extra) => ctx.replyWithHTML(html, extra)
    : telegram
      ? (html, extra) =>
          telegram.sendMessage(chatId, html, {
            parse_mode: "HTML",
            ...(extra || {}),
          })
      : (html, extra) => ctx.replyWithHTML(html, extra);

  const telegramId = ctx.from.id;
  const mileageValue = parseMileageNumber(mileage);

  if (!mileageValue) {
    await replyFn(
      "❌ Неверный формат\n\nВведите от 2 до 6 цифр. Например: <code>25408</code>",
    );
    return;
  }

  safeLog.log("mileage save: starting", {
    telegramId,
    mileageValue,
    expectedFileId,
  });
  await withState(telegramId, async (state) => {
    let effectiveState = state;

    if (!state || !state.mileageRow || !state.day || !state.stage) {
      if (
        fallbackState &&
        fallbackState.mileageRow &&
        fallbackState.day &&
        fallbackState.stage &&
        (!state || !state.fileId || state.fileId === expectedFileId)
      ) {
        safeLog.log("mileage save: using fallback state", {
          telegramId,
          expectedFileId,
        });
        effectiveState = fallbackState;
      } else {
        safeLog.log("mileage save: invalid state", {
          telegramId,
          state: !!state,
          hasFileId: !!state?.fileId,
        });
        await replyFn("⚠️ Не удалось записать пробег\n\nПопробуйте ещё раз.");
        return state;
      }
    }

    if (expectedFileId && effectiveState.fileId !== expectedFileId) {
      safeLog.log("mileage save: state changed during OCR, skipping", {
        telegramId,
        expectedFileId,
        currentFileId: effectiveState.fileId,
      });
      await replyFn(
        "⚠️ Пробег распознан, но вы начали новое действие\n\nОтправьте фото повторно, если нужно.",
        mileageConfirmKeyboard(),
      );
      return state;
    }

    state = effectiveState;

    try {
      safeLog.log("mileage save: calling updateMileage", {
        telegramId,
        mileageValue,
      });
      await updateMileage(
        state.mileageRow,
        state.day,
        state.stage,
        mileageValue,
        state.workplace,
      );
      safeLog.log("mileage save: updateMileage done", {
        telegramId,
        mileageValue,
      });
      const currentMileageStatus = getShiftStatus(telegramId, "mileage");
      if (state.stage === "start") {
        setShiftStatus(
          telegramId,
          "mileage",
          currentMileageStatus === "end" || currentMileageStatus === "both"
            ? "both"
            : "start",
        );
      } else {
        setShiftStatus(
          telegramId,
          "mileage",
          currentMileageStatus === "start" || currentMileageStatus === "both"
            ? "both"
            : "end",
        );
      }
      const curMileage = Number(
        getUserField(telegramId, "mileageRecords") || 0,
      );
      setUserField(telegramId, "mileageRecords", curMileage + 1);
      logOcrFeedback(
        telegramId,
        state.ocrValue || null,
        mileageValue,
        sourceBuffer,
        {
          stage: state.stage,
          workplace: state.workplace,
          fio: state.fio,
          fileId: state.fileId,
        },
      );
      const newState = {
        ...state,
        awaitingMileagePhoto: false,
        awaitingManualMileage: false,
        photoReceived: true,
        savedMileage: mileageValue,
        mileageProcessing: false,
      };
      const oldLast = replyManager.getLastBotMessage(telegramId);
      const oldReplyMsgId =
        oldLast && oldLast.hasKeyboard ? oldLast.msgId : null;

      await replyFn(
        `✅ Пробег записан\n` +
          `──────────────\n\n` +
          `🚗 <code>${mileageValue}</code> км\n\n` +
          `📝 Неверно? → «Изменить пробег»`,
        mileageSavedKeyboard(),
      );

      if (oldReplyMsgId && ctx.chat?.id) {
        await ctx.telegram
          .deleteMessage(ctx.chat.id, oldReplyMsgId)
          .catch(() => {});
      }
      if (ctx.chat?.id) {
        const menu = getMenuForRole(telegramId);
        if (menu?.reply_markup) {
          await funReactions.sendFunReaction(ctx, "success", menu.reply_markup);
        }
      }
      safeLog.log("mileage save: completed", { telegramId, mileageValue });
      return newState;
    } catch (error) {
      safeLog.error("mileage save: error", {
        telegramId,
        mileageValue,
        error: error.message || error,
      });
      await replyFn("⚠️ Не удалось записать пробег\n\nПопробуйте ещё раз.");
      return { ...state, mileageProcessing: false };
    }
  });
}

async function backToMainMenu(ctx) {
  const state = getState(ctx.from.id);

  if (state?.mileageProcessing) {
    return { status: "mileage_processing" };
  }

  clearState(ctx.from.id);

  const message = state?.savedMileage
    ? "⬅️ Возвращаю в меню."
    : state?.mileageRow
      ? "⬅️ Возвращаю в меню. Пробег не сохранён."
      : "⬅️ Возвращаю в меню.";

  return { status: "back_to_menu", message };
}

async function showIssuesMenu(ctx) {
  if (isLogist(ctx.from.id)) {
    return { status: "access_denied" };
  }
  const deliveryUrl = process.env.ISSUE_DELIVERY_URL;
  const flowwowUrl = process.env.ISSUE_FLOWWOW_URL;
  const techsupportUrl = process.env.ISSUE_TECHSUPPORT_URL;

  const buttons = [];

  if (deliveryUrl) {
    buttons.push([
      Markup.button.url(
        "📦 Доставка — проблемы с нашими заказами",
        deliveryUrl,
      ),
    ]);
  }
  if (flowwowUrl) {
    buttons.push([
      Markup.button.url("🌸 Flowwow — заказы Flowwow", flowwowUrl),
    ]);
  }
  if (techsupportUrl) {
    buttons.push([
      Markup.button.url(
        "🔧 Техподдержка — технические проблемы",
        techsupportUrl,
      ),
    ]);
  }

  if (buttons.length === 0) {
    return { status: "unavailable" };
  }

  buttons.push([styledButton("❌ Закрыть", "close_message", "danger")]);

  await ctx.replyWithHTML(
    "⚠️ <b>Проблема с заказом</b>\n\nВыберите чат для обращения:",
    Markup.inlineKeyboard(buttons),
  );
  return { status: "showing_issues" };
}

// Парсим ADMIN_IDS из .env. Кэшируем результат в _adminIdsCache, чтобы
// не разбирать строку на каждом сообщении (раньше это происходило в
// 5+ местах кода).

async function notifyAdmins(html, options = {}) {
  // Уведомить всех админов. Заблокированный админ пропускается без шума.
  for (const adminId of getAdminIds()) {
    try {
      await bot.telegram.sendMessage(adminId, html, {
        parse_mode: "HTML",
        ...options,
      });
    } catch (e) {
      safeLog.error("admin notify failed", adminId, e.message);
    }
  }
}

function formatNoSheetMessage(result, workplace) {
  if (result?.noSheetForMonth && result?.monthKey) {
    return `❌ Для магазина <b>${esc(workplace)}</b> не привязана таблица на месяц <code>${esc(result.monthKey)}</code>.\nОбратитесь к администратору.`;
  }

  if (result?.noSheet) {
    return "❌ Таблица не привязана для вашего магазина.\nОбратитесь к администратору.";
  }

  return "❌ Не удалось найти сотрудника в таблице.";
}

const ocrFeedbackPath = path.join(__dirname, "ocr_feedback.json");
const MAX_OCR_FEEDBACK = LIMITS.MAX_OCR_FEEDBACK;

function logOcrFeedback(
  telegramId,
  ocrMileage,
  confirmedMileage,
  sourceBuffer,
  meta = {},
) {
  if (!Number.isFinite(confirmedMileage) || confirmedMileage <= 0) return;

  const isMismatch = ocrMileage !== confirmedMileage;

  if (isMismatch) {
    try {
      let feedback = [];
      try {
        if (fs.existsSync(ocrFeedbackPath)) {
          feedback = JSON.parse(fs.readFileSync(ocrFeedbackPath, "utf8"));
        }
      } catch (e) {
        /* ignore */
      }

      feedback.push({
        ocr: ocrMileage,
        confirmed: confirmedMileage,
        diff: confirmedMileage - (ocrMileage || 0),
        date: new Date().toISOString(),
        userId: telegramId,
      });

      if (feedback.length > MAX_OCR_FEEDBACK) {
        feedback = feedback.slice(-MAX_OCR_FEEDBACK);
      }

      fs.writeFileSync(
        ocrFeedbackPath,
        JSON.stringify(feedback, null, 2),
        "utf8",
      );
    } catch (error) {
      safeLog.error("OCR feedback log error", error.message);
    }

    if (sourceBuffer) {
      saveOcrDebugImage(sourceBuffer, {
        status: "ocr_mismatch",
        ocrResult: ocrMileage,
        userCorrectedValue: confirmedMileage,
        telegramId,
        stage: meta.stage || null,
        workplace: meta.workplace || null,
        fio: meta.fio || null,
        fileId: meta.fileId || null,
      });
    }
  } else if (ocrMileage === confirmedMileage && ocrMileage !== null) {
    updateOcrDebugStatus(meta.fileId, "confirmed_ok");
  }
}

function parseMileageNumber(value) {
  const text = String(value || "").replace(/\D/g, "");
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
    stage: state?.stage || null,
  };
}

function getMileageColumnsForState(workplace, day) {
  const base = getMileageColumnsByDay(day);
  const offset = getSheetConfig(workplace)?.mileageDayOffset || 0;

  return {
    startColumn: base.startColumn + offset,
    endColumn: base.endColumn + offset,
    totalColumn: base.totalColumn + offset,
  };
}

function getMileageStageCell(state, stage = state?.stage) {
  if (!state?.mileageRow || !state?.day) return null;

  const workplace =
    state.workplace || getUserField(state.telegramId, "workplace");
  if (!workplace) return null;

  const config = getSheetConfig(workplace);
  const columns = getMileageColumnsForState(workplace, state.day);
  const column = stage === "start" ? columns.startColumn : columns.endColumn;

  return {
    workplace,
    sheetName: config.mileageSheet,
    cell: `${getColumnLetter(column)}${state.mileageRow}`,
  };
}

registerSheetCommand(bot, { esc, workplaces: WORKPLACES, isAdminUser });

const _workplaceKeys = Object.values(WORKPLACE_KEY_MAP)
  .concat(["all"])
  .join("|");

async function replaceMileageFlow(ctx, stage) {
  const profile = await ensureProfile(ctx);

  if (!profile) {
    return { status: "no_profile" };
  }

  try {
    const result = await prepareMileage(profile.fio, profile.workplace, stage);

    if (result.notFound) {
      return { status: "not_found", result, workplace: profile.workplace };
    }

    setState(
      ctx.from.id,
      makeMileageState(ctx.from.id, applyProfile(result, profile), {
        source: "mileage",
      }),
    );
    safeLog.log("ожидание замены пробега", stage);
    await ctx.replyWithHTML(
      `📸 Замена пробега\n` +
        `──────────────\n\n` +
        `📷 Фото для: <b>${esc(formatStage(stage))}</b>`,
      skipMileageKeyboard(),
    );
    return { status: "awaiting_photo" };
  } catch (error) {
    safeLog.error("ошибка Google Sheets", error);
    return { status: "error" };
  }
}

async function replaceTimeAction(ctx, stage) {
  const profile = await ensureProfile(ctx);
  if (!profile) return { status: "no_profile" };

  try {
    const result = await replaceTime(profile.fio, profile.workplace, stage);

    if (result.notFound) {
      return { status: "not_found", result, workplace: profile.workplace };
    }

    safeLog.log("время записано", `replace_${stage}`);
    const currentTimeStatus = getShiftStatus(ctx.from.id, "time");
    if (stage === "start") {
      setShiftStatus(
        ctx.from.id,
        "time",
        currentTimeStatus === "end" || currentTimeStatus === "both"
          ? "both"
          : "start",
      );
    } else {
      setShiftStatus(
        ctx.from.id,
        "time",
        currentTimeStatus === "start" || currentTimeStatus === "both"
          ? "both"
          : "end",
      );
    }
    clearState(ctx.from.id);
    return { status: "replaced", stage, timeValue: result.timeValue };
  } catch (error) {
    safeLog.error("ошибка Google Sheets", error);
    return { status: "error" };
  }
}

async function handleRouteSheetPhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  safeLog.log("фото маршрутного листа получено");
  const date = getTodayText();
  const routeSheetNumber = getNextRouteSheetNumber(state, date);
  logRouteSheetPhoto(telegramId, fileId, state, date, routeSheetNumber);

  try {
    const forwarded = await sendPhotoToRouteSheetChat(
      ctx,
      fileId,
      buildRouteSheetCaption(state, routeSheetNumber, ctx.from.id),
    );
    savePhotoThread(forwarded, ctx.from.id, "route_sheet");

    if (!forwarded) {
      await ctx.replyWithHTML(
        "⚠️ Проблема с отправкой\n\nСообщите администратору.",
        routeSheetKeyboard(),
      );
      return;
    }

    await ctx.replyWithHTML(
      `✅ Маршрутный лист №${routeSheetNumber}\n` +
        `──────────────\n\n` +
        `Фото отправлено. Можно добавить ещё.`,
      routeSheetKeyboard(),
    );
  } catch (error) {
    safeLog.error("telegram send route sheet photo error", error);
    await ctx.replyWithHTML(
      "⚠️ Не удалось отправить фото\n\nПопробуйте ещё раз.",
      routeSheetKeyboard(),
    );
  }
}

async function finalizeReconciliationPostSend(
  ctx,
  state,
  telegramId,
  totalOrders,
) {
  const errors = [];

  if (totalOrders && totalOrders > 0 && state.fio && state.workplace) {
    const timezone = process.env.APP_TIMEZONE || "Europe/Moscow";
    const { day } = getCurrentDateInfo(timezone);

    try {
      const result = await updateEfficiencyOrders(
        state.fio,
        state.workplace,
        day,
        totalOrders,
      );
      if (result.ok) {
        safeLog.log(
          `эффективность: записано ${totalOrders} заказов для ${state.fio}, день ${day}, ячейка ${result.cell}`,
        );
      } else {
        safeLog.error("эффективность: не удалось записать", result.error);
        errors.push("заказы в таблицу эффективности");
      }
    } catch (effError) {
      safeLog.error(
        "эффективность: ошибка записи",
        effError.message || effError,
      );
      errors.push("заказы в таблицу эффективности");
    }
  }

  if (errors.length > 0) {
    return { status: "partial_error", errors };
  }
  return { status: "ok" };
}

async function handleReconciliationPhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  const photosSent = (state.reconciliationPhotosSent || 0) + 1;
  const total = state.reconciliationTotal || 1;
  const isTerminal = state.device === "Терминал";
  const isTerminalFirstPhoto = isTerminal && photosSent === 1;

  if (isTerminalFirstPhoto) {
    const loadingMsg = await ctx.telegram.sendMessage(
      ctx.chat.id,
      "📸 Обрабатываю фото сверки...",
      { parse_mode: "HTML" },
    );
    const cashInfo = await recognizeReconciliationCashSafe(
      ctx,
      fileId,
      "Терминал",
    );
    const cashAmount = cashInfo.amount;
    const shouldAttachCash = cashInfo.valid && cashAmount > 0;
    const cashFormatted = shouldAttachCash ? formatMoneyRu(cashAmount) : null;

    const captionLines = [
      `📊 Сверки — Терминал (статистика)`,
      `👤 <a href="tg://user?id=${telegramId}">${esc(getEmployeeDisplayName(state.fio))}</a>`,
      `🏬 ${esc(state.workplace || "не указано")}`,
    ];

    if (shouldAttachCash && cashFormatted) {
      const rawAmount = Number(cashAmount);
      if (
        !Number.isFinite(rawAmount) ||
        rawAmount < 1 ||
        rawAmount > MAX_REASONABLE_CASH_AMOUNT
      ) {
        safeLog.log(
          "сверка OCR: сумма наличных вне допустимого диапазона",
          rawAmount,
        );
      } else {
        // Накапливаем долг: если у курьера уже есть наличные к сдаче,
        // сумма новой сверки прибавляется к существующей, а не заменяет её.
        const existingCash = getPendingCash(telegramId);
        const priorAmount = Number(existingCash?.amount || 0);
        const totalAmount = roundMoney(
          (Number.isFinite(priorAmount) ? priorAmount : 0) + rawAmount,
        );
        const totalFormatted = formatMoneyRu(totalAmount);
        const totalNumberOnly =
          formatMoneyRuNumber(totalAmount) ||
          String(totalFormatted).replace(/\s*₽$/, "");

        captionLines.push(
          `💵 К сдаче (всего): <code>${esc(totalNumberOnly)}</code> ₽`,
        );

        setPendingCash(telegramId, {
          amount: totalAmount,
          formatted: totalFormatted,
          orders: (Number(existingCash?.orders) || 0) + 1,
          workplace: state.workplace || null,
          sourceLabel: "Терминал",
          updatedAt: new Date().toISOString(),
          fileId,
        });
      }
    }

    const caption = truncateCaption(captionLines.join("\n"));

    safeLog.log(
      "фото сверок получено",
      `${photosSent}/${total}`,
      "(статистика)",
    );
    logReconciliationPhoto(telegramId, fileId, state, "Терминал (статистика)");
    appendLog(reconciliationLogPath, {
      at: new Date().toISOString(),
      type: "cash_detection",
      telegramId,
      fileId,
      workplace: state?.workplace || null,
      label: "Терминал (статистика)",
      cashOrders: shouldAttachCash ? 1 : 0,
      cashAmount: cashAmount,
      totalOrders: null,
      cashApplied: Boolean(shouldAttachCash),
      reason: shouldAttachCash ? "ok" : "no_cash",
    });

    setState(telegramId, {
      ...state,
      reconciliationPhotosSent: photosSent,
      reconciliationPhoto1FileId: fileId,
      reconciliationPhoto1Caption: caption,
      reconciliationPhoto1TotalOrders: cashInfo.totalOrders || null,
      reconciliationPhoto1OcrReason: shouldAttachCash
        ? "ok"
        : cashInfo.reason || "no_cash",
    });

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `✅ Фото 1 из 2 получено\n` +
        `──────────────\n\n` +
        `📷 Теперь отправьте фото <b>2 из 2</b>: 🧾 Чек`,
      { parse_mode: "HTML", reply_markup: routeSheetKeyboard().reply_markup },
    );
    replyManager.setLastBotMessage(ctx.from.id, loadingMsg.message_id, true);
    return;
  }

  if (isTerminal && photosSent === 2) {
    safeLog.log("фото сверок получено", `${photosSent}/${total}`, "(чек)");
    logReconciliationPhoto(telegramId, fileId, state, "Терминал (чек)");
    appendLog(reconciliationLogPath, {
      at: new Date().toISOString(),
      type: "cash_detection",
      telegramId,
      fileId,
      workplace: state?.workplace || null,
      label: "Терминал (чек)",
      cashOrders: 0,
      cashAmount: 0,
      cashApplied: false,
      reason: "чек — OCR пропущен",
    });

    const photo1FileId = state.reconciliationPhoto1FileId;
    const photo1Caption = state.reconciliationPhoto1Caption || "";

    try {
      const forwarded = await sendMediaGroupToReconciliationChat(ctx, [
        { fileId: photo1FileId, caption: photo1Caption },
        { fileId, caption: "" },
      ]);

      if (!forwarded || !Array.isArray(forwarded) || forwarded.length === 0) {
        await ctx.replyWithHTML(
          "⚠️ Проблема с отправкой\n\nСообщите администратору.",
          routeSheetKeyboard(),
        );
        return;
      }
      savePhotoThread(forwarded[0], ctx.from.id, "reconciliation");

      const ocrWarning =
        !state.reconciliationPhoto1TotalOrders &&
        state.reconciliationPhoto1OcrReason
          ? `\n\n⚠️ OCR не распознал заказы/наличные. Фото отправлены, но данные не записаны автоматически.`
          : "";
      const totalOrders = state.reconciliationPhoto1TotalOrders;
      const postRes = await finalizeReconciliationPostSend(
        ctx,
        state,
        telegramId,
        totalOrders,
      );
      clearState(telegramId);
      return { status: "photos_sent_terminal", ocrWarning, postRes };
    } catch (error) {
      safeLog.error("telegram send reconciliation album error", error);
      await ctx.replyWithHTML(
        "⚠️ Не удалось отправить фото\n\nПопробуйте ещё раз.",
        routeSheetKeyboard(),
      );
    }
    return;
  }

  const label = "Пин-Панель";
  const cashInfo = await recognizeReconciliationCashSafe(ctx, fileId, label);
  const cashAmount = cashInfo.amount;
  const shouldAttachCash = cashInfo.valid && cashAmount > 0;
  const cashFormatted = shouldAttachCash ? formatMoneyRu(cashAmount) : null;

  const captionLines = [
    `📊 Сверки — ${esc(label)}`,
    `👤 <a href="tg://user?id=${telegramId}">${esc(getEmployeeDisplayName(state.fio))}</a>`,
    `🏬 ${esc(state.workplace || "не указано")}`,
  ];

  if (shouldAttachCash && cashFormatted) {
    const rawAmount = Number(cashAmount);
    if (
      !Number.isFinite(rawAmount) ||
      rawAmount < 1 ||
      rawAmount > MAX_REASONABLE_CASH_AMOUNT
    ) {
      safeLog.log(
        "сверка OCR: сумма наличных вне допустимого диапазона",
        rawAmount,
      );
    } else {
      // Накапливаем долг: если у курьера уже есть наличные к сдаче,
      // сумма новой сверки прибавляется к существующей, а не заменяет её.
      const existingCash = getPendingCash(telegramId);
      const priorAmount = Number(existingCash?.amount || 0);
      const totalAmount = roundMoney(
        (Number.isFinite(priorAmount) ? priorAmount : 0) + rawAmount,
      );
      const totalFormatted = formatMoneyRu(totalAmount);
      const totalNumberOnly =
        formatMoneyRuNumber(totalAmount) ||
        String(totalFormatted).replace(/\s*₽$/, "");

      captionLines.push(
        `💵 К сдаче (всего): <code>${esc(totalNumberOnly)}</code> ₽`,
      );

      setPendingCash(telegramId, {
        amount: totalAmount,
        formatted: totalFormatted,
        orders: (Number(existingCash?.orders) || 0) + 1,
        workplace: state.workplace || null,
        sourceLabel: label,
        updatedAt: new Date().toISOString(),
        fileId,
      });
    }
  }

  const caption = truncateCaption(captionLines.join("\n"));

  safeLog.log("фото сверок получено", `${photosSent}/${total}`);
  logReconciliationPhoto(telegramId, fileId, state, label);
  appendLog(reconciliationLogPath, {
    at: new Date().toISOString(),
    type: "cash_detection",
    telegramId,
    fileId,
    workplace: state?.workplace || null,
    label,
    cashOrders: shouldAttachCash ? 1 : 0,
    cashAmount: cashAmount,
    totalOrders: null,
    cashApplied: Boolean(shouldAttachCash),
    reason: shouldAttachCash ? "ok" : "no_cash",
  });

  try {
    const forwarded = await sendPhotoToReconciliationChat(ctx, fileId, caption);

    if (!forwarded) {
      await ctx.replyWithHTML(
        "⚠️ Проблема с отправкой\n\nСообщите администратору.",
        routeSheetKeyboard(),
      );
      return;
    }
    savePhotoThread(forwarded, telegramId, "reconciliation");

    const ocrWarning =
      !shouldAttachCash && !cashInfo.totalOrders
        ? `\n\n⚠️ OCR не распознал сумму наличных. Фото отправлено, но данные не записаны автоматически.`
        : "";
    const postRes = await finalizeReconciliationPostSend(
      ctx,
      state,
      telegramId,
      cashInfo.totalOrders,
    );
    clearState(telegramId);
    return { status: "photos_sent", total, ocrWarning, postRes };
  } catch (error) {
    safeLog.error("telegram send reconciliation photo error", error);
    await ctx.replyWithHTML(
      "⚠️ Не удалось отправить фото\n\nПопробуйте ещё раз.",
      routeSheetKeyboard(),
    );
  }
}

async function handleMileagePhoto(ctx, state, fileId) {
  const telegramId = ctx.from.id;
  const chatId = ctx.chat.id;
  const telegram = ctx.telegram;

  if (isMileagePhotoRateLimited(telegramId)) {
    await ctx.replyWithHTML(
      "⚠️ Слишком много фото пробега. Попробуйте через минуту.",
      getMenuForRole(telegramId),
    );
    return;
  }

  const canProceed = await withState(telegramId, async (lockedState) => {
    if (lockedState?.mileageProcessing) {
      return false;
    }
    safeLog.log("фото получено");
    logMileagePhoto(telegramId, fileId, lockedState);
    const photoState = {
      ...lockedState,
      awaitingMileagePhoto: false,
      awaitingManualMileage: false,
      photoReceived: true,
      fileId,
      mileageProcessing: true,
    };
    return photoState;
  });

  if (canProceed === false) {
    await ctx.replyWithHTML(
      "⏳ Дождитесь завершения обработки предыдущего фото.",
      getMenuForRole(telegramId),
    );
    return;
  }

  const photoState = canProceed;

  const ocrAvailable = isGeminiOcrEnabled();

  if (!ocrAvailable) {
    const loadingMsg = await ctx.telegram.sendMessage(
      ctx.chat.id,
      "📸 Фото принято. Обрабатываю...",
      { parse_mode: "HTML" },
    );
    await withState(telegramId, async (lockedState) => {
      if (!lockedState || lockedState.fileId !== fileId) return lockedState;
      return {
        ...lockedState,
        mileageProcessing: false,
        awaitingMileagePhoto: true,
        awaitingManualMileage: true,
        recognizedMileage: null,
        ocrValue: null,
      };
    });
    try {
      const forwarded = await sendPhotoToWorkChat(
        ctx,
        fileId,
        buildPhotoCaption(state, telegramId),
      );
      savePhotoThread(forwarded, telegramId, "mileage");
    } catch (error) {
      safeLog.error("telegram send photo error", error);
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      "⚠️ Сервер распознавания недоступен\n\nВведите пробег вручную или отправьте фото повторно.",
      {
        parse_mode: "HTML",
        reply_markup: mileageConfirmKeyboard().reply_markup,
      },
    );
    replyManager.setLastBotMessage(ctx.from.id, loadingMsg.message_id, true);
    return;
  }

  const loadingMsg = await ctx.telegram.sendMessage(
    ctx.chat.id,
    "📸 Фото принято. Считываю пробег...",
    { parse_mode: "HTML" },
  );
  const ocrHealthy = await checkGeminiOcrHealth();
  if (!ocrHealthy) {
    safeLog.warn(
      "Gemini OCR health check failed, falling back to manual input",
    );
    await withState(telegramId, async (lockedState) => {
      if (!lockedState || lockedState.fileId !== fileId) return lockedState;
      return {
        ...lockedState,
        mileageProcessing: false,
        awaitingMileagePhoto: true,
        awaitingManualMileage: true,
        recognizedMileage: null,
        ocrValue: null,
      };
    });
    try {
      const forwarded = await sendPhotoToWorkChat(
        ctx,
        fileId,
        buildPhotoCaption(state, telegramId),
      );
      savePhotoThread(forwarded, telegramId, "mileage");
    } catch (error) {
      safeLog.error("telegram send photo error", error);
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      "⚠️ Сервер распознавания недоступен\n\nВведите пробег вручную или отправьте фото повторно.",
      {
        parse_mode: "HTML",
        reply_markup: mileageConfirmKeyboard().reply_markup,
      },
    );
    replyManager.setLastBotMessage(ctx.from.id, loadingMsg.message_id, true);
    return;
  }

  withTimeout(
    processMileagePhotoInBackground(
      telegram,
      chatId,
      telegramId,
      photoState,
      fileId,
      photoState,
      loadingMsg.message_id,
    ),
    120000,
    "mileage processing",
  ).catch(async (err) => {
    if (err.message && err.message.includes("timeout")) {
      safeLog.error("mileage processing timeout");
      await withState(telegramId, async (lockedState) => {
        if (!lockedState || lockedState.fileId !== fileId) return lockedState;
        return {
          ...lockedState,
          mileageProcessing: false,
          awaitingMileagePhoto: true,
          awaitingManualMileage: true,
        };
      });
      telegram
        .sendMessage(
          chatId,
          "⚠️ Время распознавания истекло\n\nВведите пробег вручную или отправьте фото повторно.",
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    } else {
      safeLog.error("mileage bg error:", err.message);
    }
  });
}

async function processMileagePhotoInBackground(
  telegram,
  chatId,
  telegramId,
  originalState,
  fileId,
  photoState,
  loadingMessageId = null,
) {
  const sendOrEdit = async (html, extra = {}) => {
    try {
      if (loadingMessageId) {
        await telegram.editMessageText(
          chatId,
          loadingMessageId,
          undefined,
          html,
          { parse_mode: "HTML", ...extra },
        );
        return;
      }
    } catch (e) {
      safeLog.error("edit loading message error", e.message);
    }
    try {
      await telegram.sendMessage(chatId, html, {
        parse_mode: "HTML",
        ...extra,
      });
    } catch (e) {
      safeLog.error("background sendMsg error", e.message);
    }
  };

  const sendMsg = async (html, extra) => {
    try {
      await telegram.sendMessage(chatId, html, {
        parse_mode: "HTML",
        ...(extra || {}),
      });
    } catch (e) {
      safeLog.error("background sendMsg error", e.message);
    }
  };

  try {
    safeLog.log("mileage bg: start processing", { telegramId, fileId });

    const [recognitionOptions, forwardedResult] = await Promise.all([
      buildMileageRecognitionOptions(originalState),
      forwardPhoto(
        { telegram },
        fileId,
        buildPhotoCaption(originalState, telegramId),
        "work",
      ).catch((error) => {
        safeLog.error("telegram send photo error", error);
        return null;
      }),
    ]);
    savePhotoThread(forwardedResult, telegramId, "mileage");
    safeLog.log("mileage bg: recognition options built", recognitionOptions);

    const sourceBuffer = await downloadTelegramFile({ telegram }, fileId);
    safeLog.log("mileage bg: file downloaded", { size: sourceBuffer?.length });

    const ocrResult = await recognizeMileage(
      { telegram, chat: { id: chatId } },
      fileId,
      {
        ...recognitionOptions,
        sourceBuffer,
        onStatus: async (msg) => {
          try {
            await sendMsg(msg);
          } catch (e) {
            /* ignore */
          }
        },
      },
    );

    const mileageValue = ocrResult?.mileage || null;
    const ocrCandidates = ocrResult?.candidates || [];
    safeLog.log("mileage bg: OCR result", {
      mileageValue,
      candidateCount: ocrCandidates.length,
      model: ocrResult?.model,
    });

    if (!mileageValue) {
      if (sourceBuffer) {
        saveOcrDebugImage(sourceBuffer, {
          status: ocrCandidates.length > 0 ? "ocr_weak" : "ocr_fail",
          ocrResult: ocrCandidates.length > 0 ? ocrCandidates[0].mileage : null,
          userCorrectedValue: null,
          telegramId,
          stage: originalState.stage,
          workplace: originalState.workplace,
          fio: originalState.fio,
          fileId,
        });
      }

      const shouldUpdate = await withState(telegramId, async (lockedState) => {
        if (!lockedState || lockedState.fileId !== fileId) return false;
        return true;
      });

      if (shouldUpdate) {
        await withState(telegramId, async (lockedState) => {
          if (!lockedState || lockedState.fileId !== fileId) return lockedState;
          return {
            ...photoState,
            mileageProcessing: false,
            awaitingMileagePhoto: true,
            awaitingManualMileage: true,
            recognizedMileage: null,
            ocrValue: null,
          };
        });
      }

      let failMsg = "⚠️ Не удалось распознать пробег\n──────────────\n\n";
      if (ocrCandidates.length > 0) {
        const candidateList = ocrCandidates
          .slice(0, 3)
          .map((c) => `<code>${c.mileage}</code> км`)
          .join(", ");
        failMsg += `Возможные значения: ${candidateList}\n\n`;
      }
      failMsg += "Отправьте фото повторно крупным планом или введите вручную.";
      await sendOrEdit(failMsg, mileageConfirmKeyboard());
      return;
    }

    const stillRelevant = await withState(telegramId, async (lockedState) => {
      if (
        !lockedState ||
        lockedState.fileId !== fileId ||
        !lockedState.mileageProcessing
      ) {
        return false;
      }
      return true;
    });

    if (!stillRelevant) {
      safeLog.log("mileage bg: state changed, ignoring OCR result");
      return;
    }

    await saveMileageFromState(
      {
        from: { id: telegramId },
        chat: { id: chatId },
        telegram,
        replyWithHTML: (html, extra) => sendOrEdit(html, extra),
      },
      mileageValue,
      {
        sourceBuffer,
        telegram,
        chatId,
        expectedFileId: fileId,
        fallbackState: originalState,
      },
    );
  } catch (error) {
    safeLog.error("background mileage processing error", error);
    await sendOrEdit(
      "⚠️ Ошибка обработки фото\n\nПопробуйте отправить ещё раз.",
      mileageConfirmKeyboard(),
    );
  } finally {
    await withState(telegramId, async (lockedState) => {
      if (!lockedState || lockedState.fileId !== fileId) return lockedState;
      if (!lockedState.mileageProcessing) return lockedState;
      return {
        ...lockedState,
        mileageProcessing: false,
        awaitingMileagePhoto: true,
        awaitingManualMileage: true,
      };
    });
  }
}

async function handleManualTime(ctx, state, text) {
  const telegramId = ctx.from.id;
  const timeValue = normalizeTimeValue(text);

  if (!timeValue) {
    await ctx.replyWithHTML(
      "❌ Неверный формат времени\n\n" +
        "Допустимые форматы:\n" +
        "• <code>7</code> или <code>7,5</code>\n" +
        "• <code>07:30</code> или <code>08:46</code>\n" +
        "• <code>8 14</code> (часы 0–24)\n\n" +
        "Минуты округляются до ближайших 30.",
    );
    return "error";
  }

  try {
    await updateCourierTime(
      state.courierRow,
      state.day,
      state.stage,
      timeValue,
      state.workplace,
    );
    // Обновляем статус смены, чтобы reply-кнопка времени перерисовалась верно
    // (textRouter после "done" вызывает replaceMessage с getMenuForRole).
    const currentTimeStatus = getShiftStatus(telegramId, "time");
    if (state.stage === "start") {
      setShiftStatus(
        telegramId,
        "time",
        currentTimeStatus === "end" || currentTimeStatus === "both"
          ? "both"
          : "start",
      );
    } else {
      setShiftStatus(
        telegramId,
        "time",
        currentTimeStatus === "start" || currentTimeStatus === "both"
          ? "both"
          : "end",
      );
    }
    clearState(telegramId);
    safeLog.log("время изменено", state.stage);
    const icon = state.stage === "start" ? "🟢" : "🔴";
    const label = state.stage === "start" ? "Старт" : "Конец";
    await ctx.replyWithHTML(
      `${icon} <b>${label} смены</b> изменён\n\n⏰ <code>${esc(timeValue)}</code>`,
    );
    return "done";
  } catch (error) {
    safeLog.error("ошибка Google Sheets", error);
    await ctx.replyWithHTML(
      "⚠️ Не удалось изменить время\n\nПопробуйте ещё раз.",
    );
    return "error";
  }
}

async function requireFio(ctx) {
  const fio = getUserField(ctx.from.id, "fio");
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
    "⚠️ Смена сотрудника\n──────────────\n\nВсе данные будут удалены:\n• ФИО\n• Номер машины\n• Магазин\n• Устройство\n\nВы уверены?",
    switchUserKeyboard(),
  );
}

async function handleSheetsInfo(ctx, state, text, telegramId) {
  const hasAccess =
    isAdminUser(telegramId) ||
    isSheetAccessUser(telegramId) ||
    getUserRole(telegramId) === "logist";
  if (!hasAccess) {
    // Раньше предлагали «нажмите Мой ID», но эта кнопка спрятана в
    // подменю Управление — пользователь не знал куда идти. Теперь
    // inline-кнопка прямо здесь.
    await ctx.replyWithHTML(
      "⛔ У вас нет доступа к этому разделу.\n\n" +
        "Получите ваш Telegram ID и отправьте его администратору.",
      Markup.inlineKeyboard([
        [styledButton("🆔 Получить мой ID", "show_my_id", "primary")],
      ]),
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
    msg += `   Текущий: ${activeId ? "✅ привязана" : "❌ нет"}\n`;
    msg += `   Следующий: ${nextId ? "✅ привязана" : "❌ нет"}\n`;
    const sourceText = info.sheetId
      ? info.isMonthly
        ? `monthly (${info.monthKey})`
        : "global fallback"
      : "not configured";
    msg += `   Источник: ${esc(sourceText)}\n\n`;
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
  const firstName = ctx.from.first_name || "";
  const lastName = ctx.from.last_name || "";
  const username = ctx.from.username ? `@${ctx.from.username}` : "";
  const displayName =
    [firstName, lastName].filter(Boolean).join(" ") || "Без имени";

  await ctx.replyWithHTML(
    `🆔 <b>Ваш Telegram ID:</b> <code>${userId}</code>\n\n` +
      "Сообщите этот ID администратору для получения доступа к разделу «📋 Таблицы».",
  );

  await notifyAdmins(
    `🆔 <b>Запрос доступа к Таблицам</b>\n\n` +
      `👤 ${esc(displayName)} ${esc(username)}\n` +
      `🆔 <code>${userId}</code>\n\n` +
      `Дать доступ: <code>/sheet_access ${userId}</code>`,
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
    await ctx.replyWithHTML("⚠️ Обновление уже обработано или устарело.");
    return;
  }
  const customHighlights = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4);
  const fullMessage =
    `🆕 <b><i>Обновление бота v${esc(editVersion)}</i></b>\n\n` +
    "<b>Коротко, что изменили:</b>\n" +
    customHighlights.map((item) => `• ${esc(item)}`).join("\n") +
    "\n\n💙 Хорошей смены!";
  _pendingUpdates[editVersion] = { ...pending, message: fullMessage };
  savePendingUpdates();
  const keyboard = Markup.inlineKeyboard([
    [
      styledButton("✅ Отправить", `upd_send:${editVersion}`, "success"),
      styledButton("✏️ Изменить текст", `upd_edit:${editVersion}`, "primary"),
    ],
    [styledButton("⏭️ Пропустить", `upd_skip:${editVersion}`)],
  ]);
  await ctx.replyWithHTML("<b>Предпросмотр:</b>\n\n" + fullMessage, keyboard);
}

async function handleManualMileageInput(ctx, state, text) {
  if (!/^\d{2,6}$/.test(text)) {
    await ctx.replyWithHTML(
      "❌ Неверный формат\n\nВведите от 2 до 6 цифр. Например: <code>25408</code>",
    );
    return "error";
  }
  if (state?.mileageProcessing) {
    await ctx.replyWithHTML(
      "⏳ Дождитесь завершения обработки фото, затем введите пробег.",
      getMenuForRole(ctx.from.id),
    );
    return "error";
  }
  await saveMileageFromState(ctx, Number(text));
  return "done";
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
  try {
    funReactions.flushFunReactionsNow();
  } catch (e) {
    safeLog.error("flushFunReactionsNow failed", e.message);
  }
}

async function shutdown(signal) {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;

  safeLog.log(`shutdown initiated by ${signal}`);
  try {
    checkpoint();
  } catch (_) {}
  flushAllSync();

  try {
    await makeBackup("pre-shutdown");
  } catch (e) {
    safeLog.error("pre-shutdown backup failed", e.message);
  }

  try {
    await bot.stop(signal);
  } catch (e) {
    safeLog.error("bot.stop failed", e.message);
  }

  setTimeout(() => {
    safeLog.log("forced exit after shutdown timeout");
    process.exit(0);
  }, 5000);
}

bot.catch(async (error, ctx) => {
  if (error.message?.includes("text must be non-empty")) return;
  safeLog.error("bot error", error.message);
  try {
    await ctx.replyWithHTML(
      "⚠️ Произошла ошибка. Попробуйте ещё раз или используйте /start.",
    );
  } catch (replyErr) {
    safeLog.error("failed to send error reply:", replyErr.message);
  }
});

process.on("uncaughtException", (error) => {
  safeLog.error("uncaught exception:", error);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  safeLog.error("unhandled rejection:", reason);
  // Do not shutdown on unhandledRejection; log and notify admins instead
  try {
    notifyAdmins(
      `⚠️ <b>Необработанная ошибка (unhandledRejection)</b>\n\n<pre>${esc(String(reason).substring(0, 500))}</pre>\n\nПроцесс продолжает работать.`,
    );
  } catch (e) {
    safeLog.error(
      "failed to notify admins about unhandled rejection",
      e.message,
    );
  }
});

const LAUNCH_RETRIES = LIMITS.LAUNCH_RETRIES;
const LAUNCH_BASE_DELAY = LIMITS.LAUNCH_BASE_DELAY_MS;
const LAUNCH_MAX_DELAY = LIMITS.LAUNCH_MAX_DELAY_MS;

// Глобальные таймеры — храним, чтобы при ретрае не плодить дубликаты
let _backupInitialTimer = null;
let _backupIntervalTimer = null;

async function setupBotCommands() {
  try {
    await bot.telegram.setMyCommands(
      [
        { command: "start", description: "Начать заново (сброс данных)" },
        { command: "refresh", description: "Обновить (перезапуск бота)" },
        { command: "settings", description: "Меню настроек" },
        { command: "cancel", description: "Отмена" },
      ],
      { scope: { type: "all_private_chats" } },
    );
  } catch (e) {
    safeLog.error("setMyCommands private error", e.message);
  }

  // Чистим команды для групп/админов/дефолта (бот предназначен только для приватов)
  await Promise.all([
    bot.telegram
      .deleteMyCommands({ scope: { type: "all_group_chats" } })
      .catch((e) => safeLog.error("deleteMyCommands group error", e.message)),
    bot.telegram
      .deleteMyCommands({ scope: { type: "all_chat_administrators" } })
      .catch((e) => safeLog.error("deleteMyCommands admins error", e.message)),
    bot.telegram
      .deleteMyCommands()
      .catch((e) => safeLog.error("deleteMyCommands default error", e.message)),
  ]);
}

const services = {
  getUserField,
  setUserField,
  markUserSeen,
  getAdminIds,
  getVersion,
  ensureProfile,
  getUserRole,
  getTimeGreeting,
  esc,
  getEmployeeDisplayName,
  askForFio,
  logistMainMenu,
  getMenuForRole,
  isLogist,
  askForCarNumber,
  askForWorkplace,
  askForDevice,
  sendHelp,
  backToMainMenu,
  isTimeButton,
  isMileageButton,
  isAdminUser,
  getSheetAccessUsers,
  addSheetAccessUser,
  removeSheetAccessUser,
  _pendingUpdates,
  savePendingUpdates,
  notifyUsersAboutUpdate,
  setState,
  getState,
  clearState,
  withState,
  withStateSync,
  clearShiftStatus,
  // text router flows
  punchTimeFlow,
  mileageFlow,
  routeSheetFlow,
  reconciliationFlow,
  showPendingCashStatus,
  showIssuesMenu,
  handleSwitchUser,
  handleSheetsInfo,
  handleMyId,
  showHistoryDatePicker,
  showDebtorsList,
  saveCarNumber,
  saveWorkplace,
  saveDevice,
  authorizeFio,
  handleManualTime,
  handleUpdateEditText,
  handleManualMileageInput,
  requireFio,
  roleChoiceKeyboard,
  getSettingsMenuForRole,
  getProfileMenuForRole,
  settingsInlineKeyboard,
  profileInlineKeyboard,
  // courier helpers
  formatNoSheetMessage,
  makeMileageState,
  applyProfile,
  replaceMileageFlow,
  replaceTimeAction,
  handleRouteSheetPhoto,
  handleReconciliationPhoto,
  handleMileagePhoto,
  finalizeReconciliationPostSend,
  saveMileageFromState,
  getTodayText,
  getNextRouteSheetNumber,
  logRouteSheetPhoto,
  buildRouteSheetCaption,
  sendPhotoToRouteSheetChat,
  sendPhotoToReconciliationChat,
  sendMediaGroupToReconciliationChat,
  savePhotoThread,
  normalizeTimeValue,
  formatStage,
  formatMoneyRu,
  notifyLogistsAboutSelfClearance,
  sendFunReaction: funReactions.sendFunReaction,
  courierMainMenu,
  replaceMessage,
  // logist helpers
  pokeCourier,
  showCashHistoryForDate,
  // common business
  getPendingCash,
  setUserField,
  setCashConfirmationStatus,
  clearPendingCashAndReminders,
  logCashAction,
  deleteUser,
  saveOcrDebugImage,
  updateOcrDebugStatus,
  getFullProfile,
  getReminder,
  updateReminder,
  deleteReminder,
  getSelfClearanceRequest,
  findLogistsForWorkplace,
  getDebtors,
  cleanupStaleReminders,
  getCashHistory,
  WORKPLACE_FEATURES,
  Markup,
  BUTTONS,
  getCurrentDateInfo,
  styledButton,
  // admin panel deps
  setPendingCash,
  getAllUserIds,
  getShiftStatus,
  roundMoney,
  normalizeFio,
  formatMoneyRuNumber,
  MAX_REASONABLE_CASH_AMOUNT,
  DEVICES,
  // sheets & ocr
  readCell,
  updateCell,
  flushSheetUpdates,
  db,
  checkpoint,
  saveThread,
  findThreadByGroupMessage,
  findThreadById,
  saveForwardedMessage,
  findForwardedMessage,
  cleanupOldThreads,
  isSheetAccessUser,
  WORKPLACES,
  LIMITS,
  getMileageStageCell,
  buildMileageRecognitionOptions,
  parseMileageNumber,
  checkGeminiOcrHealth,
  recognizeMileage,
  downloadTelegramFile,
  isGeminiOcrEnabled,
  recognizeTextWithGemini,
  getMinMileageThreshold,
  logOcrFeedback,
  isEmptyCell,
  isScheduleMarker,
  getMileageColumns: getMileageColumnsByDay,
  roundTimeToHalfHour,
  getColumnLetter,
  getCourierColumnsByDay,
  manualMileageKeyboard,
  skipMileageKeyboard,
  prepareMileage,
  replaceTime,
  punchTime,
  updateCourierTime,
  updateMileage,
  // misc
  openShopNotify,
  sendCommandsList,
  replyManager,
  syncShiftStatus,
  safeLog,
};

setupCommands(bot, services);
setupAdmin(bot, services);
setupAdminPanel(bot, services);
setupReplyForwarding(bot, services);
setupTextRouter(bot, services);
setupCourier(bot, services);
setupLogist(bot, services);

async function startBot(retry = 0) {
  if (process.env.BOT_DISABLED === "true") {
    safeLog.log("bot disabled — .env BOT_DISABLED=true");
    return;
  }
  try {
    const { version, changed, changedFiles, updates } = checkVersion();
    initGoogleSheets();
    setNotifyAdminCallback(notifyAdmins);
    loadPendingUpdatesFromDb();
    const removedMonths = cleanupOldMonths();
    if (removedMonths) {
      safeLog.log("cleaned up old month(s) from storage");
    }

    // ВАЖНО: в Telegraf 4 у bot.launch() нет коллбэка после старта — он
    // принимает options-объект. Раньше код внутри () => {...} никогда не
    // выполнялся, поэтому на проде не было setMyCommands и авто-бэкапов.
    // Теперь всё это вынесено наружу.

    // Команды Telegram и стикерпаки — fire-and-forget до launch
    setupBotCommands().catch((e) =>
      safeLog.error("setupBotCommands fatal", e.message),
    );
    funReactions
      .importConfiguredFunStickerSets({ telegram: bot.telegram })
      .catch((error) => {
        safeLog.error("fun sticker import fatal", error.message || error);
      });

    // Бэкапы — только при первом запуске, чтобы ретраи не плодили таймеры
    if (retry === 0) {
      if (_backupInitialTimer) clearTimeout(_backupInitialTimer);
      if (_backupIntervalTimer) clearInterval(_backupIntervalTimer);
      _backupInitialTimer = setTimeout(() => {
        runBackupCycle().catch((e) =>
          safeLog.error("initial backup error", e.message),
        );
      }, 5000);
      _backupIntervalTimer = setInterval(() => {
        runBackupCycle().catch((e) =>
          safeLog.error("backup cycle error", e.message),
        );
      }, BACKUP_INTERVAL_MS);
      _backupInitialTimer.unref?.();
      _backupIntervalTimer.unref?.();
    }

    // Уведомление админам об обновлении — только при changed && первом запуске
    if (changed && retry === 0) {
      setTimeout(() => {
        askAdminsAboutUpdate(version, changedFiles, updates).catch((error) => {
          safeLog.error("admin update ask fatal", error.message || error);
        });
      }, 3000);
    }

    // bot.launch() возвращает Promise, который резолвится только при stop().
    // await здесь корректен: при успехе функция "зависает" на polling,
    // при ошибке launch — попадаем в catch и делаем retry.
    await bot.launch();
    safeLog.log(`bot started v${version}${changed ? " (updated)" : ""}`);
  } catch (error) {
    const delay = Math.min(
      LAUNCH_BASE_DELAY * Math.pow(2, retry),
      LAUNCH_MAX_DELAY,
    );
    safeLog.error(
      `bot launch error (attempt ${retry + 1}/${LAUNCH_RETRIES}):`,
      error?.message || error,
    );
    if (retry < LAUNCH_RETRIES) {
      safeLog.error(`retrying in ${delay / 1000}s ...`);
      setTimeout(() => startBot(retry + 1), delay);
    } else {
      safeLog.error("max launch retries reached, exiting");
      process.exit(1);
    }
  }
}

startBot();

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
// SIGUSR2 — pm2 graceful reload и nodemon restart. Без этого хука перезапуски
// в dev/staging могли терять in-memory state и недозаписанные данные.
process.once("SIGUSR2", () => shutdown("SIGUSR2"));
// beforeExit — последний шанс сохранить данные при штатном выходе.
process.on("beforeExit", () => {
  if (_shutdownInProgress) return;
  flushAllSync();
});
