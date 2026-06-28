/**
 * Маршруты Mini App для курьера (Фаза 1).
 * Тонкий слой поверх services/courierActions.js — без бизнес-логики.
 */

const express = require("express");
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB на фото
    files: 10,
  },
});

// Оборачивает async-обработчик, прокидывая ошибки в error-middleware.
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const COURIER_HELP = [
  "🚀 <b>Мини-приложение курьера</b>",
  "",
  "⏱ <b>Время</b> — одна кнопка отмечает старт или конец смены (определяется автоматически).",
  "🚗 <b>Пробег</b> — сфотографируйте одометр, число распознаётся автоматически.",
  "📄 <b>Маршрутник</b> — отправьте фото маршрутных листов.",
  "📊 <b>Сверка</b> — фото сверки; сумма наличных считывается автоматически.",
  "💵 <b>Наличные</b> — появляется, когда есть сумма к сдаче.",
  "⚙️ <b>Профиль</b> — смена машины, магазина и устройства.",
].join("\n");

module.exports = function createCourierRouter(actions) {
  const router = express.Router();

  router.get(
    "/me",
    wrap(async (req, res) => {
      res.json(await actions.getMe(req.telegramId));
    }),
  );

  router.get("/help", (req, res) => {
    res.json({ ok: true, html: COURIER_HELP });
  });

  // --- Время ---
  router.post(
    "/time/punch",
    wrap(async (req, res) => {
      res.json(await actions.punch(req.telegramId));
    }),
  );

  router.post(
    "/time/replace",
    wrap(async (req, res) => {
      res.json(await actions.replacePunch(req.telegramId, req.body || {}));
    }),
  );

  // --- Пробег ---
  router.post(
    "/mileage/recognize",
    upload.single("photo"),
    wrap(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "no_photo" });
      }
      res.json(await actions.recognizeMileage(req.telegramId, req.file.buffer));
    }),
  );

  router.post(
    "/mileage/save",
    wrap(async (req, res) => {
      res.json(await actions.saveMileage(req.telegramId, req.body || {}));
    }),
  );

  // --- Маршрутник ---
  router.post(
    "/route-sheet",
    upload.array("photos", 10),
    wrap(async (req, res) => {
      const buffers = (req.files || []).map((f) => f.buffer);
      res.json(await actions.saveRouteSheet(req.telegramId, buffers));
    }),
  );

  // --- Сверка ---
  router.post(
    "/reconciliation",
    upload.array("photos", 10),
    wrap(async (req, res) => {
      const buffers = (req.files || []).map((f) => f.buffer);
      res.json(await actions.saveReconciliation(req.telegramId, buffers));
    }),
  );

  // --- Наличные ---
  router.post(
    "/cash/submit",
    wrap(async (req, res) => {
      res.json(await actions.submitCash(req.telegramId));
    }),
  );

  // --- Профиль ---
  router.get(
    "/profile",
    wrap(async (req, res) => {
      res.json(actions.getProfile(req.telegramId));
    }),
  );

  router.patch(
    "/profile",
    wrap(async (req, res) => {
      res.json(actions.updateProfile(req.telegramId, req.body || {}));
    }),
  );

  return router;
};
