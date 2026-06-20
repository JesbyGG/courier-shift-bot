# Changelog

Все заметные изменения проекта документируются здесь.

Формат основан на [Keep a Changelog](https://keepachangelog.com/),
проект следует [Semantic Versioning](https://semver.org/).

## [Unreleased] — 2026-05-08 — комплексный аудит и рефакторинг

### Critical (Phase 1) — потеря данных

- **Полночный пунч больше не затирается.**
  `roundMinutesToHalfHour` для часов 0–1 теперь возвращает `"0,0"`/`"1,0"`
  (вместо `"0"`/`"1"`). Это устраняет столкновение с `isEmptyCell` и
  schedule-маркером `"1"`. Раньше курьер, начавший смену в `00:10`, после
  второго пунча видел свой стартовый пунч стёртым.
- `isEmptyCell` больше не считает `"0"` и `"1"` пустыми. Schedule-маркер
  обрабатывается отдельно через `isScheduleMarker`.
- `punchTime`/`prepareMileage` явно перезаписывают ячейку, если она пустая
  ИЛИ содержит маркер `"1"` (чтобы помеченные дни графика по-прежнему
  работали).
- `storage.js` сохраняет повреждённый `users.json` в `.broken-<timestamp>`
  вместо обнуления. Раньше один битый JSON стирал базу пользователей.
- `getSheetAccessUsers` загружает `cache` перед чтением (раньше падал с NPE
  при первом вызове).
- `shutdown` идемпотентный + обработчик `SIGUSR2` (pm2 graceful reload) +
  `beforeExit` flush. Уменьшает вероятность потерь at-exit.

### High (Phase 2) — стабильность

- **Per-row mutex** в `googleSheets.js`. `punchTime`, `replaceTime`,
  `updateCourierTime`, `updateMileage` сериализуются по ключу
  `spreadsheetId:row`. Защищает от двойного тапа и параллельных запросов.
- **`bot.launch(callback)` починён.** В Telegraf 4 у `launch` нет
  callback-параметра — раньше блок `setMyCommands`/`setInterval(backup)`
  никогда не выполнялся на проде. Теперь setup вынесен до `bot.launch()`,
  бэкапы реально работают.
- Caption фото escape-аются HTML и truncate до 1024 символов (Telegram
  лимит для caption — НЕ 4096).
- AI-vision больше не принимает галлюцинации. Раньше любое число в ±5%
  от диапазона OCR-кандидатов записывалось как факт. Теперь требуется
  СТРОГОЕ совпадение с одним из кандидатов.
- `sheetCommand.js`: null-check `ctx.from` и `ctx.message` (защита от
  крэша на канал-постах).

### Medium (Phase 3) — UX-полировка

- `mainMenu` — компактная сетка 2×N (раньше время и пробег занимали по
  целой строке).
- `skipMileageKeyboard` — добавлены «Ввести вручную» и «В меню»
  (раньше была только «Пропустить» — курьер без камеры был в тупике).
- `routeSheetKeyboard` — добавлена кнопка «✅ Завершить» с явным финалом.
- `BUTTONS.back: 🏠 В меню` (раньше `⬅️ Назад` дублировался с
  `backToSettings`). `backToSettings: ↩️ К настройкам`.
- Все «Cancel»-кнопки: `❌` вместо `⬅️`. Все «В меню»: `🏠`.
- Шутливый тон («Котоконтроль», «Ай-ай») гейтится через `FUN_TONE=true`
  в `.env`. По умолчанию — деловой стиль.
- `showStatus`: пустые поля рендерятся плоским `—` без `<code>` (не
  читается как минус).
- «Чат не настроен» / «Распознавание не настроено» → нейтральные
  «Временные проблемы» (не утечка инфраструктуры).
- Дублирующие списки кнопок («• Терминал \n • Пин-Панель») убраны —
  они и так видны на клавиатуре.
- В разделе «Доступ к Таблицам» — inline-кнопка «🆔 Получить мой ID»
  прямо в сообщении (раньше юзер не знал, где искать кнопку «Мой ID»).
- Динамический `nextLabel` в reconciliation вместо хардкода.

### Low (Phase 4) — рефакторинг

- Новый файл `config.js`: единая точка истины для `WORKPLACES`,
  `DEVICES`, `WORKPLACE_KEY_MAP`, `LIMITS`, `SHEET_TEMPLATE`.
- `bot.on('text')` переписан как dispatcher table (`TEXT_ROUTES`)
  вместо 200+ строк if/elif.
- 4 крупных inline-блока вынесены в `handleSwitchUser`,
  `handleSheetsInfo`, `handleMyId`, `handleUpdateEditText`,
  `handleManualMileageInput`.
- `replace_start` / `replace_end` объединены через
  `replaceTimeAction(stage)`.
- `sendPhotoTo*Chat` унифицированы через `PHOTO_DESTINATIONS` config.
- `getAdminIds()` helper с кэшем (заменяет 4 inline-копии парсинга
  `ADMIN_IDS`).
- `notifyAdmins(html)` helper для уведомлений админам.

### Tests (Phase 0)

- Добавлен `tests/` с собственным раннером (без зависимостей).
- 141 кейс: `utils`, `normalizeTime`, `parseMileage`, `extractCash`.
- `npm test` запускает всё.

### Docs (Phase 5)

- `.env.example` — расширенные комментарии и группировка по секциям,
  добавлен `FUN_TONE`.
- `README.md` — секция «Архитектура» с описанием файлов проекта.
- Этот `CHANGELOG.md`.

### Phase C — аудит: рефакторинг и тесты

- **Извлечены модули из `bot.js`:**
  - `services/photoForwarder.js` — пересылка фото и медиагрупп.
  - `services/backup.js` — бэкапы SQLite через `VACUUM INTO`.
  - `services/version.js` — версионирование, git-лог, changelog bump.
- **Централизованное логирование:** почти все `console.log/error/warn` в
  `bot.js` переведены на `utils/safeLog.js` (маскирование PII).
- **Удалены неиспользуемые импорты** (`axios`, `execSync`) из `bot.js`.
- **Восстановлены тесты:** `tests/run.js` с собственным раннером.
  16 кейсов для `utils`, `safeLog`, `version`. `npm test` проходит.

### Phase D — безопасность (следующая итерация)

- Ротация секретов (`BOT_TOKEN`, `GOOGLE_PRIVATE_KEY`, `GEMINI_API_KEY`).
- Перевод оставшихся `console.*` в `db.js` и сервисах на `safeLog`.

- **Sticker / animation ограничены приватным чатом.** Реакции больше не
  срабатывают в группах/топиках, где бот видит чужие медиа.
- **`deploy.sh`:** резервная копия кода перед деплоем, `npm ci`, health-check
  бота и OCR-сервера, автоматический rollback при падении проверки.
- **Rate limiting:** защита от спама фото пробега (`MILEAGE_RATE_LIMIT_*`).
- **Forum topics (`message_thread_id`):** сохраняются в `message_threads` и
  используются при ответе курьера из группы-форума.
- **`npm audit fix`:** устранены уязвимости `axios`, `brace-expansion`,
  `form-data`. Оставшиеся 2 moderate уязвимости — транзитивные от `gaxios`
  (Google API) и требуют обновления пакетов Google вручную.
- **PII redaction:** добавлен `utils/safeLog.js`, чувствительные логи
  (медленные запросы, ID пользователей, ошибки рассылок) маскируют
  телефоны, email, ID и токены.
- **Консистентные бэкапы SQLite:** `database.sqlite` теперь бэкапится через
  `VACUUM INTO` вместо `copyFile`, что гарантирует целостную копию в WAL-режиме.
