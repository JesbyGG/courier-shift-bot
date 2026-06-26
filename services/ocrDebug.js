const fs = require("fs");
const path = require("path");
const db = require("../db");
const safeLog = require("../utils/safeLog");

const OCR_DEBUG_DIR = path.join(__dirname, "..", "ocr_debug");
const MAX_DISK_MB = 2000;
const MAX_FILES = 300;
const MAX_AGE_DAYS = 30;

function ensureDir() {
  if (!fs.existsSync(OCR_DEBUG_DIR)) {
    fs.mkdirSync(OCR_DEBUG_DIR, { recursive: true });
  }
}

function getFileSizeMb(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.size / (1024 * 1024);
  } catch {
    return 0;
  }
}

/**
 * Сохраняет фото для отладки OCR.
 * @param {Buffer} imageBuffer - сырые байты изображения
 * @param {Object} meta - метаданные
 * @param {string} meta.status - 'ocr_fail' | 'ocr_mismatch' | 'confirmed_ok'
 * @param {number|null} meta.ocrResult - что распознал OCR (null если не распознал)
 * @param {number|null} meta.userCorrectedValue - что ввёл пользователь
 * @param {number} meta.telegramId - ID пользователя
 * @param {string} meta.stage - 'start' | 'end'
 * @param {string} meta.workplace - магазин
 * @param {string} meta.fio - ФИО
 * @param {string} meta.fileId - Telegram file_id
 */
function saveOcrDebugImage(imageBuffer, meta) {
  if (!imageBuffer || imageBuffer.length < 100) return null;

  const dateStr = new Date().toISOString().slice(0, 10);
  const shortFileId = (meta.fileId || "unknown").slice(-12);
  const safeStage = String(meta.stage || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 30);
  const safeStatus = String(meta.status || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 30);
  const fileName = `${dateStr}_${meta.telegramId}_${safeStage}_${safeStatus}_${shortFileId}.jpg`;
  const filePath = path.join(OCR_DEBUG_DIR, fileName);

  try {
    ensureDir();
    fs.writeFileSync(filePath, imageBuffer);
    const sizeMb = getFileSizeMb(filePath);

    const stmt = db.prepare(
      "INSERT OR REPLACE INTO ocr_debug (fileName, filePath, timestamp, telegramId, stage, workplace, fio, fileId, ocrResult, userCorrectedValue, status, sizeMb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    stmt.run(
      fileName,
      filePath,
      new Date().toISOString(),
      String(meta.telegramId),
      meta.stage || null,
      meta.workplace || null,
      meta.fio || null,
      meta.fileId || null,
      meta.ocrResult !== undefined ? meta.ocrResult : null,
      meta.userCorrectedValue !== undefined ? meta.userCorrectedValue : null,
      meta.status || "ocr_fail",
      Math.round(sizeMb * 100) / 100,
    );

    cleanupOldFiles();
    return fileName;
  } catch (error) {
    safeLog.error("ocrDebug: save error", error.message);
    return null;
  }
}

/**
 * Обновляет статус существующей записи по fileId.
 */
function updateOcrDebugStatus(fileId, status, userCorrectedValue) {
  if (!fileId) return;
  const stmt = db.prepare(
    "UPDATE ocr_debug SET status = ?, userCorrectedValue = ? WHERE fileId = ?",
  );
  stmt.run(
    status,
    userCorrectedValue !== undefined ? userCorrectedValue : null,
    fileId,
  );
}

function getTotalSizeMb() {
  const row = db.prepare("SELECT SUM(sizeMb) as total FROM ocr_debug").get();
  return row && row.total ? row.total : 0;
}

function cleanupOldFiles() {
  try {
    ensureDir();
    const now = Date.now();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const deleteStmt = db.prepare("DELETE FROM ocr_debug WHERE fileName = ?");

    const allRows = db
      .prepare("SELECT * FROM ocr_debug ORDER BY timestamp DESC")
      .all();

    // 1. Удалить по возрасту (>30 дней)
    for (const row of allRows) {
      const ts = new Date(row.timestamp).getTime();
      if (now - ts > maxAgeMs) {
        try {
          if (fs.existsSync(row.filePath)) fs.unlinkSync(row.filePath);
        } catch (_) {}
        deleteStmt.run(row.fileName);
      }
    }

    // 2. Удалить по количеству (>300), сначала confirmed_ok, потом ocr_fail, потом ocr_mismatch
    const remaining = db.prepare("SELECT * FROM ocr_debug").all();
    if (remaining.length > MAX_FILES) {
      const statusOrder = { confirmed_ok: 0, ocr_fail: 1, ocr_mismatch: 2 };
      remaining.sort((a, b) => {
        const sa = statusOrder[a.status] || 1;
        const sb = statusOrder[b.status] || 1;
        if (sa !== sb) return sa - sb;
        return new Date(a.timestamp) - new Date(b.timestamp);
      });

      while (remaining.length > MAX_FILES) {
        const row = remaining.shift();
        if (!row) break;
        try {
          if (fs.existsSync(row.filePath)) fs.unlinkSync(row.filePath);
        } catch (_) {}
        deleteStmt.run(row.fileName);
      }
    }

    // 3. Удалить по размеру (>2000 MB)
    while (getTotalSizeMb() > MAX_DISK_MB) {
      const oldest = db
        .prepare("SELECT * FROM ocr_debug ORDER BY timestamp ASC LIMIT 1")
        .get();
      if (!oldest) break;
      try {
        if (fs.existsSync(oldest.filePath)) fs.unlinkSync(oldest.filePath);
      } catch (_) {}
      deleteStmt.run(oldest.fileName);
    }
  } catch (error) {
    safeLog.error("ocrDebug: cleanup error", error.message);
  }
}

module.exports = {
  saveOcrDebugImage,
  updateOcrDebugStatus,
  cleanupOldFiles,
  getTotalSizeMb,
};
