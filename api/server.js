/**
 * HTTP API для Telegram Mini App.
 *
 * Запускается ВНУТРИ процесса бота (см. startApiServer), чтобы переиспользовать
 * bot.telegram (пересылка фото) и общую SQLite-базу без гонок между процессами.
 * Слушает только loopback (127.0.0.1) — наружу выставляется через Cloudflare
 * Tunnel (HTTPS), фронт ходит на этот туннель.
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const { createAuthMiddleware } = require("./auth");
const createCourierActions = require("../services/courierActions");
const createCourierRouter = require("./routes/courier");
const safeLog = require("../utils/safeLog");

function parseOrigins() {
  const raw = process.env.MINI_APP_ORIGIN || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCorsOptions() {
  const allowed = parseOrigins();
  return {
    origin(origin, callback) {
      // Запросы без Origin (curl, мобильный WebView) — пропускаем.
      if (!origin) return callback(null, true);
      if (allowed.length === 0 || allowed.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Telegram-Init-Data",
      "X-Dev-User-Id",
    ],
    maxAge: 600,
  };
}

/**
 * @param {Telegraf} bot экземпляр Telegraf (нужен bot.telegram)
 * @param {object} [hooks] прокидываемые из bot.js функции с побочными эффектами
 *   (notifyLogistsAboutSelfClearance, logCashAction)
 * @returns {Promise<import('http').Server|null>}
 */
async function startApiServer(bot, hooks = {}) {
  const port = Number(process.env.API_PORT || 0);
  if (!port) {
    safeLog.log("[api] API_PORT не задан — Mini App API не запускается");
    return null;
  }

  const actions = createCourierActions({ telegram: bot.telegram, hooks });

  const app = express();
  app.disable("x-powered-by");
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: "1mb" }));

  // Health-чек без авторизации.
  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // Все остальные /api/* — только с валидным initData.
  app.use("/api", createAuthMiddleware({ botToken: process.env.BOT_TOKEN }));
  app.use("/api", createCourierRouter(actions));

  // Единый обработчик ошибок.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, error: `upload_${err.code}` });
    }
    const status = err.status || 500;
    if (status >= 500) {
      safeLog.error("[api] error", err?.stack || err?.message || err);
    }
    res.status(status).json({ ok: false, error: err.code || err.message || "error" });
  });

  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => {
      safeLog.log(`[api] Mini App API слушает 127.0.0.1:${port}`);
      resolve(server);
    });
    server.on("error", (err) => {
      safeLog.error("[api] не удалось запустить сервер", err.message);
      resolve(null);
    });
  });
}

module.exports = { startApiServer };
