const fs = require('fs');
const path = require('path');

const OCR_DEBUG_DIR = path.join(__dirname, '..', 'ocr_debug');
const INDEX_FILE = path.join(OCR_DEBUG_DIR, 'index.json');
const MAX_DISK_MB = 2000;
const MAX_FILES = 300;
const MAX_AGE_DAYS = 30;

function ensureDir() {
  if (!fs.existsSync(OCR_DEBUG_DIR)) {
    fs.mkdirSync(OCR_DEBUG_DIR, { recursive: true });
  }
}

function readIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('ocrDebug: readIndex error', e.message);
  }
  return {};
}

function writeIndex(index) {
  try {
    ensureDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
  } catch (e) {
    console.error('ocrDebug: writeIndex error', e.message);
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
  const shortFileId = (meta.fileId || 'unknown').slice(-12);
  const fileName = `${dateStr}_${meta.telegramId}_${meta.stage}_${meta.status}_${shortFileId}.jpg`;
  const filePath = path.join(OCR_DEBUG_DIR, fileName);

  try {
    ensureDir();
    fs.writeFileSync(filePath, imageBuffer);
    const sizeMb = getFileSizeMb(filePath);

    const index = readIndex();
    index[fileName] = {
      fileName,
      filePath,
      timestamp: new Date().toISOString(),
      telegramId: meta.telegramId,
      stage: meta.stage || null,
      workplace: meta.workplace || null,
      fio: meta.fio || null,
      fileId: meta.fileId || null,
      ocrResult: meta.ocrResult !== undefined ? meta.ocrResult : null,
      userCorrectedValue: meta.userCorrectedValue !== undefined ? meta.userCorrectedValue : null,
      status: meta.status || 'ocr_fail',
      sizeMb: Math.round(sizeMb * 100) / 100
    };
    writeIndex(index);

    cleanupOldFiles();
    return fileName;
  } catch (error) {
    console.error('ocrDebug: save error', error.message);
    return null;
  }
}

/**
 * Обновляет статус существующей записи по fileId.
 */
function updateOcrDebugStatus(fileId, status, userCorrectedValue) {
  if (!fileId) return;
  const index = readIndex();
  let changed = false;
  for (const key of Object.keys(index)) {
    if (index[key].fileId === fileId) {
      index[key].status = status;
      if (userCorrectedValue !== undefined) {
        index[key].userCorrectedValue = userCorrectedValue;
      }
      changed = true;
      break;
    }
  }
  if (changed) {
    writeIndex(index);
  }
}

function getTotalSizeMb() {
  const index = readIndex();
  let total = 0;
  for (const key of Object.keys(index)) {
    total += index[key].sizeMb || 0;
  }
  return total;
}

function cleanupOldFiles() {
  try {
    ensureDir();
    const index = readIndex();
    const now = Date.now();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    let changed = false;

    // 1. Удалить по возрасту (>30 дней)
    for (const key of Object.keys(index)) {
      const ts = new Date(index[key].timestamp).getTime();
      if (now - ts > maxAgeMs) {
        const fp = path.join(OCR_DEBUG_DIR, key);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
        delete index[key];
        changed = true;
      }
    }

    // 2. Удалить по количеству (>300), сначала confirmed_ok, потом ocr_fail, потом ocr_mismatch
    const ordered = Object.entries(index).sort((a, b) => {
      const statusOrder = { confirmed_ok: 0, ocr_fail: 1, ocr_mismatch: 2 };
      const sa = statusOrder[a[1].status] || 1;
      const sb = statusOrder[b[1].status] || 1;
      if (sa !== sb) return sa - sb;
      return new Date(a[1].timestamp) - new Date(b[1].timestamp);
    });

    while (ordered.length > MAX_FILES) {
      const entry = ordered.shift();
      if (!entry) break;
      const [key] = entry;
      const fp = path.join(OCR_DEBUG_DIR, key);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
      delete index[key];
      changed = true;
    }

    // 3. Удалить по размеру (>2000 MB)
    while (getTotalSizeMb() > MAX_DISK_MB && ordered.length > 0) {
      const entry = ordered.shift();
      if (!entry) break;
      const [key] = entry;
      if (index[key]) {
        const fp = path.join(OCR_DEBUG_DIR, key);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
        delete index[key];
        changed = true;
      }
    }

    if (changed) {
      writeIndex(index);
    }
  } catch (error) {
    console.error('ocrDebug: cleanup error', error.message);
  }
}

module.exports = {
  saveOcrDebugImage,
  updateOcrDebugStatus,
  cleanupOldFiles,
  getTotalSizeMb
};
