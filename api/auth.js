/**
 * Валидация Telegram Mini App initData.
 *
 * Алгоритм (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   secret_key = HMAC_SHA256(<bot_token>, "WebAppData")
 *   hash       = HMAC_SHA256(data_check_string, secret_key)
 * где data_check_string — пары "key=value", отсортированные по ключу и
 * соединённые "\n", без поля hash.
 */

const crypto = require("crypto");
const safeLog = require("../utils/safeLog");

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60; // 24 часа

function timingSafeEqualHex(a, b) {
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} initData строка из window.Telegram.WebApp.initData
 * @param {string} botToken токен бота
 * @param {object} [options]
 * @param {number} [options.maxAgeSeconds] макс. возраст auth_date (0 = не проверять)
 * @returns {{ok:boolean, error?:string, user?:object, telegramId?:number, authDate?:number}}
 */
function validateInitData(initData, botToken, options = {}) {
  const maxAgeSeconds =
    options.maxAgeSeconds == null ? DEFAULT_MAX_AGE_SECONDS : options.maxAgeSeconds;

  if (!initData || typeof initData !== "string") {
    return { ok: false, error: "missing_init_data" };
  }
  if (!botToken) {
    return { ok: false, error: "no_bot_token" };
  }

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (_) {
    return { ok: false, error: "malformed_init_data" };
  }

  const hash = params.get("hash");
  if (!hash) {
    return { ok: false, error: "no_hash" };
  }
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!timingSafeEqualHex(computedHash, hash)) {
    return { ok: false, error: "bad_hash" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (maxAgeSeconds > 0 && authDate > 0) {
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > maxAgeSeconds) {
      return { ok: false, error: "expired", authDate };
    }
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (_) {
    user = null;
  }

  if (!user || !user.id) {
    return { ok: false, error: "no_user" };
  }

  return { ok: true, user, telegramId: Number(user.id), authDate };
}

/**
 * Express middleware. Ожидает initData в заголовке:
 *   Authorization: tma <initData>
 * либо
 *   X-Telegram-Init-Data: <initData>
 *
 * Опциональный dev-байпас (только если API_ALLOW_DEV_AUTH=1): заголовок
 * X-Dev-User-Id позволяет тестировать API без подписи Telegram.
 */
function createAuthMiddleware(options = {}) {
  const botToken = options.botToken || process.env.BOT_TOKEN;
  const allowDev =
    options.allowDev != null
      ? options.allowDev
      : process.env.API_ALLOW_DEV_AUTH === "1";

  return function authMiddleware(req, res, next) {
    if (allowDev) {
      const devId = req.headers["x-dev-user-id"];
      if (devId) {
        req.telegramId = Number(devId);
        req.tgUser = { id: Number(devId), dev: true };
        return next();
      }
    }

    let initData = null;
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("tma ")) {
      initData = authHeader.slice(4).trim();
    } else if (req.headers["x-telegram-init-data"]) {
      initData = String(req.headers["x-telegram-init-data"]);
    }

    const result = validateInitData(initData, botToken);
    if (!result.ok) {
      safeLog.log("api auth rejected", result.error);
      return res.status(401).json({ ok: false, error: result.error });
    }

    req.telegramId = result.telegramId;
    req.tgUser = result.user;
    return next();
  };
}

module.exports = {
  validateInitData,
  createAuthMiddleware,
};
