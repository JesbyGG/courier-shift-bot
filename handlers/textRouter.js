module.exports = function setupTextRouter(bot, services) {
  const {
    BUTTONS,
    backToMainMenu,
    saveCarNumber,
    saveWorkplace,
    saveDevice,
    authorizeFio,
    handleManualTime,
    handleUpdateEditText,
    handleManualMileageInput,
    punchTimeFlow,
    mileageFlow,
    routeSheetFlow,
    reconciliationFlow,
    showPendingCashStatus,
    showIssuesMenu,
    showLeaderboardMenu,
    handleSwitchUser,
    handleSheetsInfo,
    handleMyId,
    showCashHistory,
    openShopNotify,
    isLogist,
    requireFio,
    askForCarNumber,
    askForWorkplace,
    askForDevice,
    getMenuForRole,
    getSettingsMenuForRole,
    getProfileMenuForRole,
    roleChoiceKeyboard,
    sendHelp,
    getState,
    formatNoSheetMessage,
    esc
  } = services;

  const TEXT_ROUTES = [
    // 1) «Назад в меню» — общая кнопка
    { match: (text) => ['🏠 В меню', '⬅️ Назад', 'Назад'].includes(text) || text === BUTTONS.back, handler: async (ctx) => {
      const res = await backToMainMenu(ctx);
      if (res.status === 'mileage_processing') await ctx.replyWithHTML('📸 Обработка фото пробега продолжается... результат придёт в новый чат.', getMenuForRole(ctx.from.id));
      else if (res.status === 'back_to_menu') await ctx.replyWithHTML(res.message, getMenuForRole(ctx.from.id));
    }},

    // 2) State-based: пользователь сейчас что-то вводит
    { state: 'awaitingCarNumber', handler: async (ctx, s, text) => {
      const result = await saveCarNumber(ctx, text);
      if (result === 'done') await ctx.replyWithHTML('✅ Готово.', getMenuForRole(ctx.from.id));
    }},
    { state: 'awaitingWorkplace', handler: async (ctx, s, text) => {
      const result = await saveWorkplace(ctx, text);
      if (result === 'done') await ctx.replyWithHTML('✅ Готово.', getMenuForRole(ctx.from.id));
    }},
    { state: 'awaitingDevice', handler: async (ctx, s, text) => {
      const result = await saveDevice(ctx, text);
      if (result === 'done') await ctx.replyWithHTML('✅ Готово.', getMenuForRole(ctx.from.id));
    }},
    { state: 'awaitingFio', handler: (ctx, s, text) => authorizeFio(ctx, text) },
    { state: 'awaitingRoleChoice', handler: (ctx) => ctx.replyWithHTML('⚠️ Выберите роль кнопкой выше.', roleChoiceKeyboard()) },
    { state: 'awaitingManualTime', handler: async (ctx, state, text) => {
      const result = await handleManualTime(ctx, state, text);
      if (result === 'done') await ctx.replyWithHTML('✅ Готово.', getMenuForRole(ctx.from.id));
    }},
    { state: 'awaitingUpdateEdit', handler: (ctx, state, text) => handleUpdateEditText(ctx, state, text) },
    { state: 'awaitingManualMileage', handler: async (ctx, state, text) => {
      const result = await handleManualMileageInput(ctx, state, text);
      if (result === 'done') await ctx.replyWithHTML('✅ Готово.', getMenuForRole(ctx.from.id));
    }},

    // 3) Кнопки главного меню
    { button: BUTTONS.punchTime, legacy: ['Время смены', 'Внести время смены', '⏱ Время'], handler: (ctx) => punchTimeFlow(ctx) },
    { button: BUTTONS.mileage, legacy: ['Внести пробег', '🚗 Пробег'], handler: async (ctx) => {
      const res = await mileageFlow(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
      else if (res.status === 'pedestrian_no_mileage') await ctx.replyWithHTML('🚶 Пешим курьерам пробег не требуется.', getMenuForRole(ctx.from.id));
      else if (res.status === 'not_found') await ctx.replyWithHTML(formatNoSheetMessage(res.result, res.workplace));
      else if (res.status === 'error') await ctx.replyWithHTML('⚠️ Не удалось подготовить запись пробега.\nПопробуйте ещё раз или обратитесь к администратору.', getMenuForRole(ctx.from.id));
    }},
    { button: BUTTONS.routeSheet, legacy: ['Маршрутный лист', '📄 Маршрутник'], handler: async (ctx) => {
      const res = await routeSheetFlow(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    }},
    { button: BUTTONS.reconciliation, legacy: ['Сверки', '📊 Сверки'], handler: async (ctx) => {
      const res = await reconciliationFlow(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    }},
    { button: BUTTONS.cashCheck, legacy: ['Деньги к сдаче', '💵 Наличные'], handler: async (ctx) => {
      const res = await showPendingCashStatus(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
      else if (res.status === 'no_debt') await ctx.replyWithHTML('✅ Долгов нет — все деньги сданы.', getMenuForRole(ctx.from.id));
      else if (res.status === 'already_submitted') await ctx.replyWithHTML('⏳ Вы уже отметили сдачу. Ожидайте подтверждения логиста.', getMenuForRole(ctx.from.id));
    }},
    { button: BUTTONS.issues, legacy: ['Проблема с заказом', '⚠️ Проблема'], handler: async (ctx) => {
      const res = await showIssuesMenu(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
      else if (res.status === 'unavailable') await ctx.replyWithHTML('⚠️ Раздел «Проблема с заказом» временно недоступен.', getMenuForRole(ctx.from.id));
    }},
    { button: BUTTONS.leaderBoard, legacy: ['Лидерборд', '🏆 Лидерборд'], handler: async (ctx) => {
      const res = await showLeaderboardMenu(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
    }},
    { button: BUTTONS.cashCollect, handler: async (ctx) => {
      const res = await showCashHistory(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только логистам.', getMenuForRole(ctx.from.id));
      else if (res.status === 'no_cash_collection') await ctx.replyWithHTML('❌ В этом магазине приём наличных не предусмотрен.', getMenuForRole(ctx.from.id));
    }},
    { button: BUTTONS.openShop, handler: async (ctx) => {
      const res = await openShopNotify(ctx);
      if (res.status === 'access_denied') await ctx.replyWithHTML('❌ Эта функция доступна только логистам.', getMenuForRole(ctx.from.id));
      else if (res.status === 'no_workplace') await ctx.replyWithHTML('⚠️ Сначала выберите магазин в настройках.', getMenuForRole(ctx.from.id));
      else if (res.status === 'ok') await ctx.replyWithHTML(`✅ Уведомление отправлено: <b>${esc(res.workplace)} — ОТКРЫТ</b> ✅`, getMenuForRole(ctx.from.id));
    }},

    // 4) Меню настроек
    { button: BUTTONS.settings, legacy: ['Настройки'], handler: async (ctx, s, text, id) => ctx.replyWithHTML('⚙️ <b>Настройки</b>', getSettingsMenuForRole(id)) },
    { button: BUTTONS.profile, legacy: ['Профиль'], handler: async (ctx, s, text, id) => ctx.replyWithHTML('✏️ <b>Профиль</b>', getProfileMenuForRole(ctx.from.id)) },
    { button: BUTTONS.help, legacy: ['Помощь'], handler: (ctx) => sendHelp(ctx) },

    // 5) Профиль (требуют ФИО)
    { button: BUTTONS.changeCar, legacy: ['Изменить номер машины', 'Номер машины'], handler: async (ctx) => {
      if (isLogist(ctx.from.id)) {
        await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
        return;
      }
      const fio = await requireFio(ctx);
      if (fio) await askForCarNumber(ctx, fio);
    }},
    { button: BUTTONS.changeWorkplace, legacy: ['Изменить интернет-магазин', 'Поменять магазин', 'Магазин'], handler: async (ctx) => {
      const fio = await requireFio(ctx);
      if (fio) await askForWorkplace(ctx, fio);
    }},
    { button: BUTTONS.changeDevice, legacy: ['Изменить устройство', 'Устройство'], handler: async (ctx) => {
      if (isLogist(ctx.from.id)) {
        await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
        return;
      }
      const fio = await requireFio(ctx);
      if (fio) await askForDevice(ctx, fio);
    }},
    { button: BUTTONS.switchUser, legacy: ['Поменять сотрудника', 'Сменить сотрудника', 'Сотрудник'], handler: handleSwitchUser },

    // 6) Настройки (Таблицы, Мой ID, История сборов)
    { button: BUTTONS.sheetInfo, legacy: ['Таблицы'], handler: handleSheetsInfo },
    { button: BUTTONS.myId, legacy: ['Мой ID'], handler: handleMyId }
  ];

  function matchTextRoute(route, text, state) {
    if (typeof route.match === 'function' && route.match(text, state)) return true;
    if (route.state && state?.[route.state]) return true;
    if (route.button) {
      if (text === route.button) return true;
      if (Array.isArray(route.legacy) && route.legacy.includes(text)) return true;
    }
    return false;
  }

  bot.on('text', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();
    const state = getState(telegramId);

    for (const route of TEXT_ROUTES) {
      if (matchTextRoute(route, text, state)) {
        return route.handler(ctx, state, text, telegramId);
      }
    }

    // Fallback
    await ctx.replyWithHTML('Выберите действие в меню или используйте /help.', getMenuForRole(telegramId));
  });
};
