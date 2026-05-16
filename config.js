// Централизованные константы и магические числа.
// Раньше были разбросаны по bot.js / storage.js / googleSheets.js — при
// изменениях легко забыть синхронизировать. Теперь — единая точка истины.

const WORKPLACES = ['ИМ Восток', 'ИМ Центр'];
const DEVICES = ['Терминал', 'Пин-Панель'];
const ROLES = ['Курьер', 'Логист'];

// Маппинг русских названий магазинов в короткие ключи (для storage / sheet IDs).
const WORKPLACE_KEY_MAP = {
  'ИМ Восток': 'east',
  'ИМ Центр': 'center'
};

// Жёсткие ограничения окружения. Можно переопределять через .env.
const LIMITS = {
  // Максимальный объём файла лога на диске (50 MB)
  MAX_LOG_SIZE_BYTES: 50 * 1024 * 1024,

  // Кол-во OCR feedback-записей в файле
  MAX_OCR_FEEDBACK: 500,

  // Авто-бэкапы данных
  BACKUP_INTERVAL_MS: 60 * 60 * 1000, // каждый час
  BACKUP_RETENTION_MS: 7 * 24 * 60 * 60 * 1000, // храним 7 дней

  // Очистка in-memory кэша cooldown'ов фан-реакций
  FUN_REACTION_CLEANUP_INTERVAL_MS: 3600000,

  // Лимит caption у Telegram (НЕ 4096 — это лимит для текста)
  TELEGRAM_CAPTION_LIMIT: 1024,

  // Размеры пробега в км (валидация)
  MILEAGE_MIN_DIGITS: 2,
  MILEAGE_MAX_DIGITS: 6,

  // Длина гос. номера машины
  CAR_NUMBER_MIN_LENGTH: 4,
  CAR_NUMBER_MAX_LENGTH: 12,

  // Запуск бота — параметры ретрая
  LAUNCH_RETRIES: 10,
  LAUNCH_BASE_DELAY_MS: 5000,
  LAUNCH_MAX_DELAY_MS: 120000
};

// Шаблон Google Sheets — колонки и блоки. Если в таблице меняется
// структура (добавили/убрали колонку), правится здесь.
const SHEET_TEMPLATE = {
  // Курьеры: колонки (start, end, hours) повторяются блоками по 3
  // начиная с дня 1. День 1 → старт=6 (F), конец=7 (G), часы=8 (H).
  courier: {
    firstDayStartCol: 6,
    blockSize: 3,
    fioStartRow: 3 // первая строка с данными курьера (после заголовков)
  },
  // Пробег: блоки (start, end, total) с колонки 4 (D)
  mileage: {
    firstDayStartCol: 4,
    blockSize: 3,
    fioStartRow: 3
  }
};

// Имя файла, в который переименовываются битые файлы при загрузке.
const STORAGE_BROKEN_SUFFIX = '.broken';

module.exports = {
  WORKPLACES,
  DEVICES,
  ROLES,
  WORKPLACE_KEY_MAP,
  LIMITS,
  SHEET_TEMPLATE,
  STORAGE_BROKEN_SUFFIX
};
