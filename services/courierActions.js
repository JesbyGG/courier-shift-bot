/**
 * Расцепленная оркестрация курьерских действий для Telegram Mini App.
 *
 * Здесь НЕТ Telegraf `ctx` и отправки сообщений пользователю — функции принимают
 * telegramId + данные и возвращают структурированный результат (JSON для API).
 * Вся реальная работа делегируется существующим сервисам, чтобы мини-апп и бот
 * не разъезжались в логике:
 *   - googleSheets.js  — запись времени/пробега в таблицу
 *   - storage.js       — профиль, наличные, статусы смены
 *   - mileageOcr.js / reconciliationOcr.js — распознавание
 *   - photoForwarder.js — пересылка фото в рабочие чаты (через bot.telegram)
 *
 * Фото из мини-аппа приходят как сырые буферы (multipart), а не как Telegram
 * file_id. Поэтому для пересылки используется "fake ctx" поверх bot.telegram,
 * а буфер передаётся в sendPhoto как { source: buffer } (поддерживается Telegram
 * Bot API / Telegraf).
 */

const storage = require("./storage");
const sheets = require("./googleSheets");
const mileageOcr = require("./mileageOcr");
const reconciliationOcr = require("./reconciliationOcr");
const photoForwarder = require("./photoForwarder");
const { getCurrentDateInfo } = require("../utils");
const {
  WORKPLACES,
  DEVICES,
  WORKPLACE_FEATURES,
  LIMITS,
} = require("../config");
const safeLog = require("../utils/safeLog");

const MAX_REASONABLE_CASH_AMOUNT = 500000;

function apiError(code, status = 400, extra = {}) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  return formatMoneyRu(value).replace(/\s*₽$/, "");
}

// Копия parseMileageNumber из bot.js — 2..6 цифр.
function parseMileageNumber(value) {
  const text = String(value == null ? "" : value).replace(/\D/g, "");
  if (!text) return null;
  const number = Number(text);
  if (!Number.isInteger(number)) return null;
  if (text.length < LIMITS.MILEAGE_MIN_DIGITS || text.length > LIMITS.MILEAGE_MAX_DIGITS) {
    return null;
  }
  return number;
}

function normalizeCarNumber(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function truncateCaption(text) {
  const limit = LIMITS.TELEGRAM_CAPTION_LIMIT || 1024;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + "…";
}

// Следующий ожидаемый этап по сохранённому статусу смены.
// 'none' -> старт, 'start' -> конец, 'end'/'both' -> завершено (null).
function nextStage(status) {
  if (status === "none") return "start";
  if (status === "start") return "end";
  return null;
}

module.exports = function createCourierActions(deps = {}) {
  const { telegram, hooks = {} } = deps;
  if (!telegram) {
    throw new Error("createCourierActions: требуется telegram (bot.telegram)");
  }

  // Минимальный ctx для переиспользования OCR/photoForwarder сервисов.
  function makeCtx(telegramId) {
    return {
      telegram,
      from: { id: telegramId },
      chat: { id: telegramId },
    };
  }

  function getProfileOrThrow(telegramId) {
    const profile = storage.getFullProfile(telegramId);
    if (!profile.fio) {
      throw apiError("not_registered", 403);
    }
    return profile;
  }

  function mileageCaption(profile, telegramId) {
    return [
      `🚗 Пробег`,
      `👤 <a href="tg://user?id=${telegramId}">${esc(profile.fio)}</a>`,
      `🏬 ${esc(profile.workplace || "не указано")}`,
      profile.carNumber ? `🚙 ${esc(profile.carNumber)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function routeSheetCaption(profile, telegramId, number) {
    return [
      `📄 Маршрутный лист №${number}`,
      `👤 <a href="tg://user?id=${telegramId}">${esc(profile.fio)}</a>`,
      `🏬 ${esc(profile.workplace || "не указано")}`,
    ].join("\n");
  }

  // ---- Главный экран -------------------------------------------------------

  async function getMe(telegramId) {
    const profile = storage.getFullProfile(telegramId);
    const role = storage.getUserRole(telegramId);
    const timeStatus = storage.getShiftStatus(telegramId, "time");
    const mileageStatus = storage.getShiftStatus(telegramId, "mileage");
    const pending = storage.getPendingCash(telegramId);

    let sheetAvailable = false;
    let monthKey = null;
    if (profile.workplace) {
      const info = storage.resolveSheetInfo(profile.workplace);
      sheetAvailable = Boolean(info.sheetId);
      monthKey = info.monthKey;
    }

    const features =
      (profile.workplace && WORKPLACE_FEATURES[profile.workplace]) || {};

    const pendingAmount = Number(pending?.amount || 0);
    const pendingCash =
      pending && Number.isFinite(pendingAmount) && pendingAmount >= 1
        ? {
            amount: pendingAmount,
            formatted: pending.formatted || formatMoneyRu(pendingAmount),
            number: formatMoneyRuNumber(pendingAmount),
            workplace: pending.workplace || profile.workplace || null,
            confirmationStatus: pending.confirmationStatus || null,
          }
        : null;

    return {
      registered: Boolean(profile.fio),
      profile,
      role,
      shift: {
        time: { status: timeStatus, nextStage: nextStage(timeStatus) },
        mileage: { status: mileageStatus, nextStage: nextStage(mileageStatus) },
      },
      pendingCash,
      sheet: { available: sheetAvailable, monthKey },
      features,
      device: profile.device || null,
      workplaces: WORKPLACES,
      devices: DEVICES,
    };
  }

  // ---- Время ---------------------------------------------------------------

  function finalizePunch(telegramId, result) {
    if (result.notFound) {
      return {
        ok: false,
        error: result.noSheet ? "no_sheet" : "courier_not_found",
        noSheetForMonth: result.noSheetForMonth,
        monthKey: result.monthKey,
      };
    }
    if (result.needsReplaceChoice) {
      return {
        ok: false,
        needsReplaceChoice: true,
        from: result.from,
        to: result.to,
      };
    }

    const cur = storage.getShiftStatus(telegramId, "time");
    if (result.stage === "start") {
      storage.setShiftStatus(
        telegramId,
        "time",
        cur === "end" || cur === "both" ? "both" : "start",
      );
    } else {
      storage.setShiftStatus(
        telegramId,
        "time",
        cur === "start" || cur === "both" ? "both" : "end",
      );
    }

    if (result.stage === "start" && cur === "none") {
      const count = Number(storage.getUserField(telegramId, "shiftCount") || 0);
      storage.setUserField(telegramId, "shiftCount", count + 1);
    }

    return { ok: true, stage: result.stage, timeValue: result.timeValue };
  }

  async function punch(telegramId) {
    const profile = getProfileOrThrow(telegramId);
    const isPedestrian = profile.courierType === "pedestrian";
    const result = await sheets.punchTime(
      profile.fio,
      profile.workplace,
      isPedestrian,
    );
    return finalizePunch(telegramId, result);
  }

  async function replacePunch(telegramId, { stage } = {}) {
    if (stage !== "start" && stage !== "end") throw apiError("invalid_stage");
    const profile = getProfileOrThrow(telegramId);
    const isPedestrian = profile.courierType === "pedestrian";
    const result = await sheets.replaceTime(
      profile.fio,
      profile.workplace,
      stage,
      isPedestrian,
    );
    return finalizePunch(telegramId, result);
  }

  // ---- Пробег --------------------------------------------------------------

  // Шаг 1: фото -> определить этап, переслать в рабочий чат, распознать значение.
  async function recognizeMileage(telegramId, buffer) {
    if (!buffer || !buffer.length) throw apiError("no_photo");
    const profile = getProfileOrThrow(telegramId);

    const prep = await sheets.prepareMileage(profile.fio, profile.workplace);
    if (prep.notFound) {
      return {
        ok: false,
        error: prep.noSheet ? "no_sheet" : "courier_not_found",
        monthKey: prep.monthKey,
      };
    }

    let stage;
    let replaceChoice = false;
    if (prep.needsReplaceChoice) {
      replaceChoice = true;
      stage = "start"; // оба заполнены — по умолчанию предлагаем заменить старт
    } else {
      stage = prep.stage;
    }

    const ctx = makeCtx(telegramId);

    // Фото пересылаем в рабочий чат сразу — как в боте (фото приходит независимо
    // от того, распозналось значение или нет).
    try {
      const forwarded = await photoForwarder.sendPhotoToWorkChat(
        ctx,
        { source: buffer },
        mileageCaption(profile, telegramId),
      );
      photoForwarder.savePhotoThread(forwarded, telegramId, "mileage");
    } catch (error) {
      safeLog.error("api mileage forward error", error?.message || error);
    }

    let recognized = null;
    try {
      if (mileageOcr.isGeminiOcrEnabled()) {
        const res = await mileageOcr.recognizeMileage(ctx, null, {
          sourceBuffer: buffer,
          minMileage: mileageOcr.getMinMileageThreshold(),
          maxMileage: null,
          stage,
        });
        recognized = res && res.mileage ? res.mileage : null;
      }
    } catch (error) {
      safeLog.error("api mileage ocr error", error?.message || error);
    }

    return { ok: true, stage, recognized, replaceChoice };
  }

  // Шаг 2: записать подтверждённое значение в таблицу.
  async function saveMileage(telegramId, { stage, value } = {}) {
    if (stage !== "start" && stage !== "end") throw apiError("invalid_stage");
    const mileageValue = parseMileageNumber(value);
    if (!mileageValue) throw apiError("invalid_mileage");

    const profile = getProfileOrThrow(telegramId);
    const prep = await sheets.prepareMileage(profile.fio, profile.workplace, stage);
    if (prep.notFound) {
      return { ok: false, error: prep.noSheet ? "no_sheet" : "courier_not_found" };
    }

    await sheets.updateMileage(
      prep.mileageRow,
      prep.day,
      stage,
      mileageValue,
      profile.workplace,
    );

    const cur = storage.getShiftStatus(telegramId, "mileage");
    if (stage === "start") {
      storage.setShiftStatus(
        telegramId,
        "mileage",
        cur === "end" || cur === "both" ? "both" : "start",
      );
    } else {
      storage.setShiftStatus(
        telegramId,
        "mileage",
        cur === "start" || cur === "both" ? "both" : "end",
      );
    }

    const count = Number(storage.getUserField(telegramId, "mileageRecords") || 0);
    storage.setUserField(telegramId, "mileageRecords", count + 1);

    return { ok: true, stage, value: mileageValue };
  }

  // ---- Маршрутник ----------------------------------------------------------

  async function saveRouteSheet(telegramId, buffers) {
    const profile = getProfileOrThrow(telegramId);
    if (!Array.isArray(buffers) || buffers.length === 0) {
      throw apiError("no_photos");
    }

    const ctx = makeCtx(telegramId);
    let sent = 0;
    for (const buf of buffers) {
      if (!buf || !buf.length) continue;
      const forwarded = await photoForwarder.sendPhotoToRouteSheetChat(
        ctx,
        { source: buf },
        routeSheetCaption(profile, telegramId, sent + 1),
      );
      if (forwarded) {
        photoForwarder.savePhotoThread(forwarded, telegramId, "route_sheet");
        sent += 1;
      }
    }

    if (!sent) return { ok: false, error: "forward_failed" };
    return { ok: true, count: sent };
  }

  // ---- Сверка --------------------------------------------------------------

  async function saveReconciliation(telegramId, buffers) {
    const profile = getProfileOrThrow(telegramId);
    if (!Array.isArray(buffers) || buffers.length === 0) {
      throw apiError("no_photos");
    }

    const isTerminal = profile.device === "Терминал";
    const label = isTerminal ? "Терминал" : "Пин-Панель";

    // OCR наличных/заказов — по первому фото (статистика).
    let cashInfo = { amount: 0, totalOrders: 0, valid: false, reason: "no_ocr" };
    try {
      if (mileageOcr.isGeminiOcrEnabled()) {
        const text = await mileageOcr.recognizeTextWithGemini(buffers[0]);
        if (text) cashInfo = reconciliationOcr.extractCashFromGemini(text);
      }
    } catch (error) {
      safeLog.error("api reconciliation ocr error", error?.message || error);
    }

    const rawAmount = Number(cashInfo.amount);
    const shouldAttachCash =
      cashInfo.valid &&
      Number.isFinite(rawAmount) &&
      rawAmount >= 1 &&
      rawAmount <= MAX_REASONABLE_CASH_AMOUNT;

    const captionLines = [
      `📊 Сверки — ${esc(label)}`,
      `👤 <a href="tg://user?id=${telegramId}">${esc(profile.fio)}</a>`,
      `🏬 ${esc(profile.workplace || "не указано")}`,
    ];

    let cashApplied = null;
    if (shouldAttachCash) {
      // Накапливаем долг (как в боте): прибавляем к существующему pending.
      const existing = storage.getPendingCash(telegramId);
      const prior = Number(existing?.amount || 0);
      const totalAmount = reconciliationOcr.roundMoney(
        (Number.isFinite(prior) ? prior : 0) + rawAmount,
      );
      const totalFormatted = formatMoneyRu(totalAmount);
      captionLines.push(
        `💵 К сдаче (всего): <code>${esc(formatMoneyRuNumber(totalAmount))}</code> ₽`,
      );

      storage.setPendingCash(telegramId, {
        amount: totalAmount,
        formatted: totalFormatted,
        orders: (Number(existing?.orders) || 0) + 1,
        workplace: profile.workplace || null,
        sourceLabel: label,
        confirmationStatus: "pending",
        updatedAt: new Date().toISOString(),
      });

      cashApplied = {
        amount: totalAmount,
        formatted: totalFormatted,
        number: formatMoneyRuNumber(totalAmount),
      };
    }

    const caption = truncateCaption(captionLines.join("\n"));

    // Пересылаем фото по одному (надёжнее, чем media group с буферами):
    // первое — с подписью, остальные — без.
    const ctx = makeCtx(telegramId);
    let sent = 0;
    for (let i = 0; i < buffers.length; i += 1) {
      const buf = buffers[i];
      if (!buf || !buf.length) continue;
      const forwarded = await photoForwarder.sendPhotoToReconciliationChat(
        ctx,
        { source: buf },
        i === 0 ? caption : "",
      );
      if (forwarded) {
        if (i === 0) {
          photoForwarder.savePhotoThread(forwarded, telegramId, "reconciliation");
        }
        sent += 1;
      }
    }

    // Эффективность (кол-во заказов) — best effort.
    if (cashInfo.totalOrders && profile.fio && profile.workplace) {
      try {
        const timezone = process.env.APP_TIMEZONE || "Europe/Moscow";
        const { day } = getCurrentDateInfo(timezone);
        await sheets.updateEfficiencyOrders(
          profile.fio,
          profile.workplace,
          day,
          cashInfo.totalOrders,
        );
      } catch (error) {
        safeLog.error("api efficiency error", error?.message || error);
      }
    }

    if (!sent) return { ok: false, error: "forward_failed" };

    return {
      ok: true,
      device: label,
      cash: cashApplied,
      totalOrders: cashInfo.totalOrders || 0,
      recognized: shouldAttachCash,
    };
  }

  // ---- Наличные ------------------------------------------------------------

  async function submitCash(telegramId) {
    const pending = storage.getPendingCash(telegramId);
    const amount = Number(pending?.amount || 0);
    if (!Number.isFinite(amount) || amount < 1) {
      return { ok: true, cleared: true, message: "Долгов нет — всё сдано." };
    }

    const formatted = pending?.formatted || formatMoneyRu(amount);
    const courierFio = storage.getUserField(telegramId, "fio") || "Неизвестный";
    const workplace =
      pending?.workplace ||
      storage.getUserField(telegramId, "workplace") ||
      "не указано";

    const wpFeatures = WORKPLACE_FEATURES[workplace];

    // Магазин без сбора наличных логистом — сразу списываем.
    if (!wpFeatures || !wpFeatures.cashCollection) {
      storage.clearPendingCashAndReminders(telegramId);
      if (typeof hooks.logCashAction === "function") {
        hooks.logCashAction({
          logistId: null,
          logistFio: null,
          courierId: String(telegramId),
          courierFio,
          workplace,
          amount,
          action: "self_cleared",
        });
      }
      const cur = Number(storage.getUserField(telegramId, "cashSubmits") || 0);
      storage.setUserField(telegramId, "cashSubmits", cur + 1);
      return { ok: true, confirmed: true, formatted, number: formatMoneyRuNumber(amount) };
    }

    // Иначе — отправляем запрос логистам на подтверждение.
    storage.setCashConfirmationStatus(telegramId, "awaiting");
    if (typeof hooks.logCashAction === "function") {
      hooks.logCashAction({
        logistId: null,
        logistFio: null,
        courierId: String(telegramId),
        courierFio,
        workplace,
        amount,
        action: "self_cleared_requested",
      });
    }
    if (typeof hooks.notifyLogistsAboutSelfClearance === "function") {
      try {
        await hooks.notifyLogistsAboutSelfClearance(
          telegramId,
          courierFio,
          amount,
          formatted,
          workplace,
        );
      } catch (error) {
        safeLog.error("api notify logists error", error?.message || error);
      }
    }

    return { ok: true, awaiting: true, formatted, number: formatMoneyRuNumber(amount) };
  }

  // ---- Профиль -------------------------------------------------------------

  function getProfile(telegramId) {
    const profile = storage.getFullProfile(telegramId);
    return { ...profile, workplaces: WORKPLACES, devices: DEVICES };
  }

  function updateProfile(telegramId, patch = {}) {
    const updated = {};

    if (patch.carNumber !== undefined) {
      const car = normalizeCarNumber(patch.carNumber);
      if (
        car.length < LIMITS.CAR_NUMBER_MIN_LENGTH ||
        car.length > LIMITS.CAR_NUMBER_MAX_LENGTH
      ) {
        throw apiError("invalid_car");
      }
      storage.setUserField(telegramId, "carNumber", car);
      updated.carNumber = car;
    }

    if (patch.workplace !== undefined) {
      if (!WORKPLACES.includes(patch.workplace)) throw apiError("invalid_workplace");
      storage.setUserField(telegramId, "workplace", patch.workplace);
      updated.workplace = patch.workplace;
    }

    if (patch.device !== undefined) {
      if (!DEVICES.includes(patch.device)) throw apiError("invalid_device");
      storage.setUserField(telegramId, "device", patch.device);
      updated.device = patch.device;
    }

    return { ok: true, updated };
  }

  return {
    getMe,
    punch,
    replacePunch,
    recognizeMileage,
    saveMileage,
    saveRouteSheet,
    saveReconciliation,
    submitCash,
    getProfile,
    updateProfile,
    // экспортируем чистые помощники для тестов
    _internal: { parseMileageNumber, formatMoneyRu, nextStage },
  };
};
