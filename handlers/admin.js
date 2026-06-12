module.exports = function setupAdmin(bot, services) {
  const { pe } = require('../services/premiumEmoji');
  const {
    isAdminUser,
    getAdminIds,
    getSheetAccessUsers,
    addSheetAccessUser,
    removeSheetAccessUser,
    getUserField,
    setUserField,
    getUserRole,
    esc,
    _pendingUpdates,
    savePendingUpdates,
    notifyUsersAboutUpdate,
    setState
  } = services;

  bot.command('sheet_access', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) {
      return;
    }

    const args = (ctx.message.text || '').replace(/^\/sheet_access\s*/, '').trim().split(/\s+/);

    if (args.length === 1 && args[0] === '') {
      const users = getSheetAccessUsers();
      const adminIds = getAdminIds();
      let msg = `${pe('📋')} <b>Доступ к Таблицам</b>\n\n`;
      msg += `${pe('🔑')} <b>Администраторы:</b>\n`;
      for (const id of adminIds) {
        msg += `   • <code>${id}</code>\n`;
      }
      msg += `\n${pe('👥')} <b>Допущенные пользователи:</b>\n`;
      if (users.length === 0) {
        msg += '   (пусто)\n';
      } else {
        for (const id of users) {
          msg += `   • <code>${id}</code>\n`;
        }
      }
      msg += '\n<b>Команды:</b>\n';
      msg += '<code>/sheet_access 123456789</code> — дать доступ\n';
      msg += '<code>/sheet_access - 123456789</code> — убрать доступ';
      await ctx.replyWithHTML(msg);
      return;
    }

    if (args[0] === '-' || args[0] === 'del' || args[0] === 'remove') {
      const targetId = Number(args[1]);
      if (!Number.isFinite(targetId) || targetId <= 0) {
        await ctx.replyWithHTML(`${pe('❌')} Неверный Telegram ID.`);
        return;
      }
      const removed = removeSheetAccessUser(targetId);
      if (removed) {
        await ctx.replyWithHTML(`${pe('✅')} Доступ к Таблицам убран для <code>${targetId}</code>`);
      } else {
        await ctx.replyWithHTML(`${pe('ℹ️')} Пользователь <code>${targetId}</code> не имел доступа.`);
      }
      return;
    }

    const targetId = Number(args[0]);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      await ctx.replyWithHTML(`${pe('❌')} Неверный Telegram ID. Используйте: <code>/sheet_access 123456789</code>`);
      return;
    }

    const added = addSheetAccessUser(targetId);
    if (added) {
      await ctx.replyWithHTML(`${pe('✅')} Доступ к Таблицам предоставлен для <code>${targetId}</code>\n\nПользователь увидит кнопку «${pe('📋')} Таблицы» в Настройках.`);
    } else {
      await ctx.replyWithHTML(`${pe('ℹ️')} Пользователь <code>${targetId}</code> уже имеет доступ.`);
    }
  });

  bot.command('role', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) {
      return;
    }

    const args = (ctx.message.text || '').replace(/^\/role\s*/, '').trim().split(/\s+/);

    if (args.length < 2) {
      await ctx.replyWithHTML(
        `${pe('🔑')} <b>Смена роли</b>\n\n` +
        'Использование: <code>/role &lt;telegram_id&gt; &lt;courier|logist&gt;</code>\n\n' +
        'Примеры:\n' +
        '<code>/role 123456789 courier</code> — сделать курьером\n' +
        '<code>/role 123456789 logist</code> — сделать логистом'
      );
      return;
    }

    const targetId = args[0];
    const newRole = args[1].toLowerCase();

    if (newRole !== 'courier' && newRole !== 'logist') {
      await ctx.replyWithHTML(`${pe('❌')} Роль должна быть <code>courier</code> или <code>logist</code>.`);
      return;
    }

    const currentFio = getUserField(targetId, 'fio');
    if (!currentFio) {
      await ctx.replyWithHTML(`${pe('❌')} Пользователь <code>${targetId}</code> не найден.`);
      return;
    }

    const oldRole = getUserRole(targetId);
    const displayRole = newRole === 'logist' ? 'Логист' : 'Курьер';
    const oldDisplayRole = oldRole === 'logist' ? 'Логист' : 'Курьер';

    setUserField(targetId, 'role', newRole);

    if (newRole === 'logist') {
      const carNumber = getUserField(targetId, 'carNumber');
      const device = getUserField(targetId, 'device');
      if (carNumber) setUserField(targetId, 'carNumber', null);
      if (device) setUserField(targetId, 'device', null);
    }

    await ctx.replyWithHTML(
      `${pe('✅')} Роль изменена: <b>${esc(currentFio)}</b> (<code>${targetId}</code>)\n\n` +
      `${oldDisplayRole} → ${displayRole}`
    );
  });

  bot.action(/^upd_send:(.+)$/, async (ctx) => {
    if (!isAdminUser(ctx.from.id)) {
      await ctx.answerCbQuery();
      return;
    }
    const version = ctx.match[1];
    const pending = _pendingUpdates[version];
    if (!pending) {
      await ctx.answerCbQuery('⚠️ Обновление уже обработано');
      return;
    }
    delete _pendingUpdates[version];
    savePendingUpdates();
    await ctx.editMessageText(`${pe('✅')} Уведомление отправляется...`, { parse_mode: 'HTML' });
    await notifyUsersAboutUpdate(version, pending.changedFiles, pending.updates || []);
    try {
      await ctx.editMessageText(`${pe('✅')} Уведомление v${esc(version)} отправлено всем пользователям.`, { parse_mode: 'HTML' });
    } catch {}
  });

  bot.action(/^upd_edit:(.+)$/, async (ctx) => {
    if (!isAdminUser(ctx.from.id)) {
      await ctx.answerCbQuery();
      return;
    }
    const version = ctx.match[1];
    const pending = _pendingUpdates[version];
    if (!pending) {
      await ctx.answerCbQuery('⚠️ Обновление уже обработано');
      return;
    }
    setState(ctx.from.id, { awaitingUpdateEdit: true, editVersion: version });
    await ctx.replyWithHTML(`${pe('✏️')} <b>Редактирование уведомления</b>\n\nОтправьте новый текст сообщения (без заголовка «Обновление бота v...» и «Хорошей смены» — они добавятся автоматически):`);
    await ctx.answerCbQuery();
  });

  bot.action(/^upd_skip:(.+)$/, async (ctx) => {
    if (!isAdminUser(ctx.from.id)) {
      await ctx.answerCbQuery();
      return;
    }
    const version = ctx.match[1];
    delete _pendingUpdates[version];
    savePendingUpdates();
    try {
      await ctx.editMessageText(`${pe('⏭️')} Уведомление v${esc(version)} пропущено.`, { parse_mode: 'HTML' });
    } catch {}
    await ctx.answerCbQuery('Пропущено');
  });
};
