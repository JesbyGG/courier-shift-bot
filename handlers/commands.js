module.exports = function setupCommands(bot, services) {
  const {
    getUserField,
    setUserField,
    markUserSeen,
    getAdminIds,
    getVersion,
    ensureProfile,
    getUserRole,
    getTimeGreeting,
    esc,
    clearShiftStatus,
    getEmployeeDisplayName,
    astForFio,
    logistMainMenu,
    getMenuForRole,
    isLogist,
    askForCarNumber,
    askForWorkplace,
    askForDevice,
    sendHelp,
    backToMainMenu,
    getState,
    clearState,
    deleteUser,
    syncShiftStatus,
    settingsInlineKeyboard,
    profileInlineKeyboard,
    replaceMessage,
    requireFio,
    handleSwitchUser,
    handleSheetsInfo,
    handleMyId,
    notifyAdmins,
    styledButton,
    Markup,
    userLastBotMessage
  } = services;

  bot.start(async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    safeLog.log('/start');

    deleteUser(ctx.from.id);
    clearState(ctx.from.id);
    clearShiftStatus(ctx.from.id);
    setUserField(ctx.from.id, 'version', getVersion());

    await ctx.replyWithHTML(`${getTimeGreeting()}! 👋\n\nБот перезапущен. Введите имя и фамилию.`);
    await askForFio(ctx);
  });

  bot.command('refresh', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    clearState(ctx.from.id);
    setUserField(ctx.from.id, 'version', getVersion());

    const fio = getUserField(ctx.from.id, 'fio');
    if (!fio) {
      await ctx.replyWithHTML('👤 Сначала зарегистрируйтесь — /start');
      return;
    }

    await syncShiftStatus(ctx);
    const menu = getMenuForRole(ctx.from.id);
    if (menu?.reply_markup) {
      await ctx.replyWithHTML('🔄 Бот обновлён', menu);
    }
  });

  bot.command('settings', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const fio = getUserField(ctx.from.id, 'fio');
    if (!fio) {
      await ctx.replyWithHTML('👤 Сначала зарегистрируйтесь — /start');
      return;
    }
    const last = userLastBotMessage.get(ctx.from.id);
    if (last?.msgId) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, last.msgId); } catch {}
    }
    await ctx.replyWithHTML('⚙️ Настройки\n──────────────', settingsInlineKeyboard(ctx.from.id));
  });

  bot.help(sendHelp);

  bot.command('car', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (isLogist(ctx.from.id)) {
      await ctx.replyWithHTML('❌ Эта команда доступна только курьерам.', getMenuForRole(ctx.from.id));
      return;
    }
    const fio = getUserField(ctx.from.id, 'fio');
    if (!fio) { await askForFio(ctx); return; }
    await askForCarNumber(ctx, fio);
  });

  bot.command('workplace', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const fio = getUserField(ctx.from.id, 'fio');
    if (!fio) { await askForFio(ctx); return; }
    await askForWorkplace(ctx, fio);
  });

  bot.command('device', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (isLogist(ctx.from.id)) {
      await ctx.replyWithHTML('❌ Эта команда доступна только курьерам.', getMenuForRole(ctx.from.id));
      return;
    }
    const fio = getUserField(ctx.from.id, 'fio');
    if (!fio) { await askForFio(ctx); return; }
    await askForDevice(ctx, fio);
  });

  bot.command('chatid', async (ctx) => {
    await ctx.replyWithHTML(
      `📍 <b>Chat info</b>\n\nchat_id: <code>${ctx.chat.id}</code>\nmessage_thread_id: <code>${ctx.message.message_thread_id || 'нет'}</code>`
    );
  });

  bot.command('cancel', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const res = await backToMainMenu(ctx);
    if (res.status === 'mileage_processing') await ctx.replyWithHTML('📸 Обработка фото пробега продолжается... результат придёт в новый чат.', getMenuForRole(ctx.from.id));
    else if (res.status === 'back_to_menu') await ctx.replyWithHTML(res.message, getMenuForRole(ctx.from.id));
  });

  bot.action('close_message', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch {}
  });

  bot.action('show_my_id', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || '';
    const lastName = ctx.from.last_name || '';
    const username = ctx.from.username ? `@${ctx.from.username}` : '';
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';

    await ctx.replyWithHTML(
      `🆔 <b>Ваш Telegram ID:</b> <code>${userId}</code>\n\n` +
      'Отправьте этот ID администратору для получения доступа.'
    );

    for (const adminId of getAdminIds()) {
      try {
        await ctx.telegram.sendMessage(adminId,
          `🆔 <b>Запрос доступа к Таблицам</b>\n\n` +
          `👤 ${esc(displayName)} ${esc(username)}\n` +
          `🆔 <code>${userId}</code>\n\n` +
          `Дать доступ: <code>/sheet_access ${userId}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (e) { /* админ заблокирован — пропускаем */ }
    }
  });

  bot.action('role_courier', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from.id;
    const state = getState(telegramId);
    if (!state?.awaitingRoleChoice) {
      await ctx.replyWithHTML('⚠️ Выбор роли устарел. Нажмите /start.', getMenuForRole(telegramId));
      return;
    }
    setUserField(telegramId, 'role', 'courier');
    setUserField(telegramId, 'courierType', 'auto');
    if (state?.workplace) {
      setUserField(telegramId, 'workplace', state.workplace);
    }
    clearState(telegramId);
    await ctx.replyWithHTML('✅ Роль: <b>Курьер</b> (авто).\n\nТеперь введите номер машины.');
    await askForCarNumber(ctx, state.fio);
  });

  bot.action('role_logist', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from.id;
    const state = getState(telegramId);
    if (!state?.awaitingRoleChoice) {
      await ctx.replyWithHTML('⚠️ Выбор роли устарел. Нажмите /start.', getMenuForRole(telegramId));
      return;
    }
    setUserField(telegramId, 'role', 'logist');
    clearState(telegramId);
    await ctx.replyWithHTML('✅ Роль: <b>Логист</b>\n\nТеперь выберите ваш магазин.', logistMainMenu(ctx.from.id));
    await askForWorkplace(ctx, state.fio);
  });

  // ─── Inline settings callbacks ───

  bot.action('cfg_back_to_menu', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch {}
    const res = await backToMainMenu(ctx);
    if (res.status !== 'mileage_processing') {
      const menuMarkup = getMenuForRole(ctx.from.id);
      if (menuMarkup?.reply_markup) {
        await ctx.replyWithHTML('🏠', menuMarkup);
      }
    }
  });

  bot.action('cfg_profile', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('👤 Профиль\n──────────────', profileInlineKeyboard(ctx.from.id));
  });

  bot.action('cfg_back_to_settings', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('⚙️ Настройки\n──────────────', settingsInlineKeyboard(ctx.from.id));
  });

  bot.action('cfg_help', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch {}
    await sendHelp(ctx);
  });

  bot.action('cfg_my_id', async (ctx) => {
    await ctx.answerCbQuery();
    await handleMyId(ctx);
  });

  bot.action('cfg_sheet_info', async (ctx) => {
    await ctx.answerCbQuery();
    await handleSheetsInfo(ctx, null, null, ctx.from.id);
  });

  bot.action('cfg_car', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch {}
    const fio = await requireFio(ctx);
    if (fio) await askForCarNumber(ctx, fio);
  });

  bot.action('cfg_workplace', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch {}
    const fio = await requireFio(ctx);
    if (fio) await askForWorkplace(ctx, fio);
  });

  bot.action('cfg_device', async (ctx) => {
    await ctx.answerCbQuery();
    if (isLogist(ctx.from.id)) {
      await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
      return;
    }
    try { await ctx.deleteMessage(); } catch {}
    const fio = await requireFio(ctx);
    if (fio) await askForDevice(ctx, fio);
  });

  bot.action('cfg_switch_user', async (ctx) => {
    await ctx.answerCbQuery();
    await handleSwitchUser(ctx);
  });
};
