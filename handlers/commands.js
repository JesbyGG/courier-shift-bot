module.exports = function setupCommands(bot, services) {
  const { pe, premiumText } = require('../services/premiumEmoji');
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
    askForFio,
    logistMainMenu,
    getMenuForRole,
    isLogist,
    askForCarNumber,
    askForWorkplace,
    askForDevice,
    sendHelp,
    backToMainMenu,
    getState,
    clearState
  } = services;

  bot.start(async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    console.log('/start');

    if (!getUserField(ctx.from.id, 'fio')) {
      setUserField(ctx.from.id, 'version', getVersion());
      clearShiftStatus(ctx.from.id);
      const isNew = markUserSeen(ctx.from.id);
      if (isNew) {
        const firstName = ctx.from.first_name || '';
        const lastName = ctx.from.last_name || '';
        const username = ctx.from.username ? `@${ctx.from.username}` : '';
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';
        const adminIds = getAdminIds();
        for (const adminId of adminIds) {
          try {
            await ctx.telegram.sendMessage(adminId,
              `${pe('🆕')} <b>Новый пользователь</b>\n\n` +
              `${pe('👤')} ${esc(displayName)} ${esc(username)}\n` +
              `${pe('🆔')} <code>${ctx.from.id}</code>`,
              { parse_mode: 'HTML' }
            );
          } catch (e) { /* ignore */ }
        }
      }
      await ctx.replyWithHTML(`${getTimeGreeting()}! ${pe('👋')} <b>Привет!</b>\n\nЭто бот для учёта смены, времени и пробега автомобиля.`);
      await askForFio(ctx);
      return;
    }

    setUserField(ctx.from.id, 'version', getVersion());
    clearShiftStatus(ctx.from.id);

    const profile = await ensureProfile(ctx);

    if (!profile) {
      await ctx.replyWithHTML(`${pe('⚠️')} Не удалось загрузить профиль. Попробуйте /start позже или обратитесь к администратору.`);
      return;
    }

    const role = getUserRole(ctx.from.id);

    if (role === 'logist') {
      await ctx.replyWithHTML(
        `${getTimeGreeting()}, <b>${esc(getEmployeeDisplayName(profile.fio))}</b>! ${pe('👋')}\n\n` +
        `${pe('⏱')} <b>Записать время</b> — отметить начало или конец смены.\n` +
        `${pe('🔓')} <b>Открыть ИМ</b> — отправить уведомление об открытии магазина в группу.\n` +
        `${pe('💳')} <b>Принять наличные</b> — посмотреть курьеров с долгами и отправить напоминание.\n` +
        `${pe('📋')} <b>Таблицы</b> — информация о привязке таблиц.\n` +
        `${pe('⚙️')} <b>Настройки</b> — профиль, магазин, смена сотрудника.`,
        logistMainMenu(ctx.from.id)
      );
    } else {
      await ctx.replyWithHTML(
        `${getTimeGreeting()}, <b>${esc(getEmployeeDisplayName(profile.fio))}</b>! ${pe('👋')}\n\n` +
        `${pe('⏱')} <b>Записать время</b> — отметить начало или конец смены, автоматически выбирается время старта и вносится в таблицу ботом.\n` +
        `${pe('🚗')} <b>Фото пробега</b> — отправить фото одометра и бот автоматически скинет фото в нужный чат и запишет пробег в таблицу.\n` +
        `${pe('📄')} <b>Отправить маршрутник</b> — прикрепить маршрутный лист, бот отправит фото в нужный чат.\n` +
        `${pe('📊')} <b>Отправить сверку</b> — отправить фото сверки, бот отправит фото в нужный чат.\n` +
        `${pe('💵')} <b>Сдать наличные</b> — отметить сдачу наличных, также укажет сумму нужную сдать и подтверждение сдал/не сдал.\n` +
        `${pe('⚠️')} <b>Проблема с заказом</b> — сообщить о проблеме, бот предлагает варианты ссылками на нужный чат/бота поддержки.\n` +
        `${pe('🏆')} <b>Рейтинг</b> — посмотреть рейтинг курьеров.\n` +
        `${pe('⚙️')} <b>Настройки</b> — профиль, машина, магазин, также смена сотрудника и тд.`,
        getMenuForRole(ctx.from.id)
      );
    }
  });

  bot.help(sendHelp);

  bot.command('car', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (isLogist(ctx.from.id)) {
      await ctx.replyWithHTML(`${pe('❌')} Эта команда доступна только курьерам.`, getMenuForRole(ctx.from.id));
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
      await ctx.replyWithHTML(`${pe('❌')} Эта команда доступна только курьерам.`, getMenuForRole(ctx.from.id));
      return;
    }
    const fio = getUserField(ctx.from.id, 'fio');
    if (!fio) { await askForFio(ctx); return; }
    await askForDevice(ctx, fio);
  });

  bot.command('chatid', async (ctx) => {
    await ctx.replyWithHTML(
      `${pe('📍')} <b>Chat info</b>\n\nchat_id: <code>${ctx.chat.id}</code>\nmessage_thread_id: <code>${ctx.message.message_thread_id || 'нет'}</code>`
    );
  });

  bot.command('cancel', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const res = await backToMainMenu(ctx);
    if (res.status === 'mileage_processing') await ctx.replyWithHTML(`${pe('📸')} Обработка фото пробега продолжается... результат придёт в новый чат.`, getMenuForRole(ctx.from.id));
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
      `${pe('🆔')} <b>Ваш Telegram ID:</b> <code>${userId}</code>\n\n` +
      'Отправьте этот ID администратору для получения доступа.'
    );

    for (const adminId of getAdminIds()) {
      try {
        await ctx.telegram.sendMessage(adminId,
          `${pe('🆔')} <b>Запрос доступа к Таблицам</b>\n\n` +
          `${pe('👤')} ${esc(displayName)} ${esc(username)}\n` +
          `${pe('🆔')} <code>${userId}</code>\n\n` +
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
      await ctx.replyWithHTML(`${pe('⚠️')} Выбор роли устарел. Нажмите /start.`, getMenuForRole(telegramId));
      return;
    }
    setUserField(telegramId, 'role', 'courier');
    setUserField(telegramId, 'courierType', 'auto');
    if (state?.workplace) {
      setUserField(telegramId, 'workplace', state.workplace);
    }
    clearState(telegramId);
    await ctx.replyWithHTML(`${pe('✅')} Роль: <b>Курьер</b> (авто).\n\nТеперь введите номер машины.`);
    await askForCarNumber(ctx, state.fio);
  });

  bot.action('role_logist', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from.id;
    const state = getState(telegramId);
    if (!state?.awaitingRoleChoice) {
      await ctx.replyWithHTML(`${pe('⚠️')} Выбор роли устарел. Нажмите /start.`, getMenuForRole(telegramId));
      return;
    }
    setUserField(telegramId, 'role', 'logist');
    clearState(telegramId);
    await ctx.replyWithHTML(`${pe('✅')} Роль: <b>Логист</b>\n\nТеперь выберите ваш магазин.`, logistMainMenu(ctx.from.id));
    await askForWorkplace(ctx, state.fio);
  });
};
