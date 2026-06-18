module.exports = function setupCourier(bot, services) {
  const {
    getState, setState, clearState,
    isLogist, getMenuForRole,
    replaceMileageFlow,
    handleRouteSheetPhoto, handleReconciliationPhoto, handleMileagePhoto,
    finalizeReconciliationPostSend, saveMileageFromState,
    formatStage, formatMoneyRu, formatNoSheetMessage,
    notifyLogistsAboutSelfClearance, sendFunReaction,
    getUserField, setUserField, getPendingCash, setCashConfirmationStatus,
    clearPendingCashAndReminders, logCashAction,
    deleteUser,
    backToMainMenu,
    replaceTimeAction,
    WORKPLACE_FEATURES, sendCommandsList,
    manualMileageKeyboard, skipMileageKeyboard, courierMainMenu,
    Markup, BUTTONS, esc
  } = services;

  bot.on('photo', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (isLogist(ctx.from.id)) {
      await ctx.replyWithHTML('❌ Эта функция доступна только курьерам.', getMenuForRole(ctx.from.id));
      return;
    }
    const telegramId = ctx.from.id;
    const state = getState(telegramId);

    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileId = bestPhoto.file_id;

    if (state?.awaitingRouteSheetPhoto) {
      return handleRouteSheetPhoto(ctx, state, fileId);
    }

    if (state?.awaitingReconciliationPhoto) {
      const res = await handleReconciliationPhoto(ctx, state, fileId);
      if (res?.status === 'photos_sent_terminal') {
        await ctx.replyWithHTML(`✅ Все фото (2 шт.) отправлены${res.ocrWarning}`, getMenuForRole(ctx.from.id));
        if (res.postRes?.status === 'partial_error') {
          await ctx.replyWithHTML(
            `⚠️ Фото отправлены, но не удалось записать:\n` +
            res.postRes.errors.map((e) => `• ${esc(e)}`).join('\n') +
            '\n\nСообщите администратору.',
            getMenuForRole(ctx.from.id)
          );
        }
      } else if (res?.status === 'photos_sent') {
        await ctx.replyWithHTML(`✅ Все фото (${res.total} шт.) отправлены${res.ocrWarning}`, getMenuForRole(ctx.from.id));
        if (res.postRes?.status === 'partial_error') {
          await ctx.replyWithHTML(
            `⚠️ Фото отправлены, но не удалось записать:\n` +
            res.postRes.errors.map((e) => `• ${esc(e)}`).join('\n') +
            '\n\nСообщите администратору.',
            getMenuForRole(ctx.from.id)
          );
        }
      }
      return;
    }

    if (!state?.awaitingMileagePhoto) {
      await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.mileage}»`, getMenuForRole(ctx.from.id));
      return;
    }

    return handleMileagePhoto(ctx, state, fileId);
  });

  bot.action('issues_back', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.deleteMessage(); } catch (e) { /* сообщение уже удалено */ }
    const res = await backToMainMenu(ctx);
    if (res.status === 'back_to_menu') await ctx.replyWithHTML(res.message, getMenuForRole(ctx.from.id));
  });

  bot.action('help_commands', async (ctx) => {
    await ctx.answerCbQuery();
    await sendCommandsList(ctx);
  });

  bot.action('confirm_switch_user', async (ctx) => {
    await ctx.answerCbQuery();
    deleteUser(ctx.from.id);
    setState(ctx.from.id, { awaitingFio: true });
    await ctx.replyWithHTML('👤 Смена сотрудника\n──────────────────────\n\nДанные удалены. Введите имя и фамилию как в таблице.');
  });

  bot.action('route_sheet_done', async (ctx) => {
    await ctx.answerCbQuery('Готово');
    const state = getState(ctx.from.id);
    clearState(ctx.from.id);
    if (state?.awaitingReconciliationPhoto) {
      const sent = state.reconciliationPhotosSent || 0;
      await ctx.replyWithHTML(
        sent > 0
          ? `✅ Завершено. Отправлено фото: <b>${sent}</b>.`
          : '✅ Завершено. Фото не отправлены.',
        courierMainMenu(ctx.from.id)
      );
      return;
    }
    const curSheets = Number(getUserField(ctx.from.id, 'routeSheetsSubmitted') || 0);
    setUserField(ctx.from.id, 'routeSheetsSubmitted', curSheets + 1);
    await ctx.replyWithHTML('✅ Маршрутный лист завершён\n\nСпасибо!', courierMainMenu(ctx.from.id));
  });

  bot.action('cash_submit_yes', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from.id;
    const pendingCash = getPendingCash(telegramId);
    const amount = Number(pendingCash?.amount || 0);

    if (!Number.isFinite(amount) || amount < 1) {
      await ctx.replyWithHTML('✅ Долгов нет — все деньги сданы.', getMenuForRole(telegramId));
      return;
    }

    const formatted = pendingCash?.formatted || formatMoneyRu(amount);
    const courierFio = getUserField(telegramId, 'fio') || 'Неизвестный';
    const workplace = pendingCash?.workplace || getUserField(telegramId, 'workplace') || 'не указано';

    const wpFeatures = WORKPLACE_FEATURES[workplace];
    if (!wpFeatures || !wpFeatures.cashCollection) {
      clearPendingCashAndReminders(telegramId);
      logCashAction({
        logistId: null, logistFio: null,
        courierId: String(telegramId), courierFio,
        workplace, amount, action: 'self_cleared'
      });
      const curCash = Number(getUserField(telegramId, 'cashSubmits') || 0);
      setUserField(telegramId, 'cashSubmits', curCash + 1);
      try {
        await ctx.editMessageText(`✅ Сдача подтверждена\n\n💰 <code>${esc(formatted)}</code> ₽`);
      } catch (e) { /* ignore */ }
      await ctx.replyWithHTML(
        `✅ Сдача подтверждена\n` +
        `──────────────────────\n\n` +
        `💰 <code>${esc(formatted)}</code> ₽\n\n` +
        `Спасибо!`,
        getMenuForRole(telegramId)
      );
      return;
    }

    setCashConfirmationStatus(telegramId, 'awaiting');

    logCashAction({
      logistId: null, logistFio: null,
      courierId: String(telegramId), courierFio,
      workplace, amount, action: 'self_cleared_requested'
    });

    await notifyLogistsAboutSelfClearance(telegramId, courierFio, amount, formatted, workplace);

    try {
      await ctx.editMessageText('⏳ Запрос отправлен. Ожидайте подтверждения.');
    } catch (e) { /* ignore */ }

    await ctx.replyWithHTML(
      `⏳ Запрос отправлен\n` +
      `──────────────────────\n\n` +
      `💰 <code>${esc(formatted)}</code> ₽\n` +
      `Ожидайте подтверждения от логиста.`,
      getMenuForRole(telegramId)
    );
  });

  bot.action('cash_submit_no', async (ctx) => {
    await ctx.answerCbQuery('❌ Отложено');
    const fun = String(process.env.FUN_TONE || '').toLowerCase() === 'true';
    const message = fun
      ? '😼 Тогда бегом сдавать деньги! Котоконтроль не дремлет 🐾\n\nКогда сдадите — нажмите «💵 Наличные».'
      : '⚠️ Не забудьте сдать деньги.\n\nКогда сдадите — нажмите «💵 Наличные».';
    await ctx.replyWithHTML(message, getMenuForRole(ctx.from.id));
  });

  bot.action('retry_mileage_photo', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);

    if (!state?.mileageRow || !state?.day || !state?.stage) {
      await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.mileage}»`, getMenuForRole(ctx.from.id));
      return;
    }

    setState(ctx.from.id, {
      ...state,
      mileageProcessing: false,
      awaitingMileagePhoto: true,
      awaitingManualMileage: false,
      recognizedMileage: null,
      ocrValue: null
    });

    await ctx.replyWithHTML('📷 Отправьте фото пробега крупным планом', skipMileageKeyboard());
  });

  bot.action('replace_mileage_start', async (ctx) => {
    await ctx.answerCbQuery();
    const res = await replaceMileageFlow(ctx, 'start');
    if (res.status === 'not_found') await ctx.replyWithHTML(formatNoSheetMessage(res.result, res.workplace));
    else if (res.status === 'error') await ctx.replyWithHTML('⚠️ Не удалось подготовить замену\n\nПопробуйте ещё раз.', getMenuForRole(ctx.from.id));
  });

  bot.action('replace_mileage_end', async (ctx) => {
    await ctx.answerCbQuery();
    const res = await replaceMileageFlow(ctx, 'end');
    if (res.status === 'not_found') await ctx.replyWithHTML(formatNoSheetMessage(res.result, res.workplace));
    else if (res.status === 'error') await ctx.replyWithHTML('⚠️ Не удалось подготовить замену\n\nПопробуйте ещё раз.', getMenuForRole(ctx.from.id));
  });

  bot.action('replace_start', async (ctx) => {
    await ctx.answerCbQuery();
    const res = await replaceTimeAction(ctx, 'start');
    if (res.status === 'replaced') {
      await ctx.replyWithHTML(`🟢 <b>Старт смены</b> заменён\n\n⏰ <code>${esc(res.timeValue)}</code>`, getMenuForRole(ctx.from.id));
    } else if (res.status === 'not_found') {
      await ctx.replyWithHTML(formatNoSheetMessage(res.result, res.workplace));
    } else if (res.status === 'error') {
      await ctx.replyWithHTML('⚠️ Не удалось записать время\n\nПопробуйте ещё раз.');
    }
  });

  bot.action('replace_end', async (ctx) => {
    await ctx.answerCbQuery();
    const res = await replaceTimeAction(ctx, 'end');
    if (res.status === 'replaced') {
      await ctx.replyWithHTML(`🔴 <b>Конец смены</b> заменён\n\n⏰ <code>${esc(res.timeValue)}</code>`, getMenuForRole(ctx.from.id));
    } else if (res.status === 'not_found') {
      await ctx.replyWithHTML(formatNoSheetMessage(res.result, res.workplace));
    } else if (res.status === 'error') {
      await ctx.replyWithHTML('⚠️ Не удалось записать время\n\nПопробуйте ещё раз.');
    }
  });

  bot.action('skip_mileage', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    const savedMileage = state?.savedMileage;

    if (state?.mileageProcessing) {
      setState(ctx.from.id, { ...state, mileageProcessing: false, awaitingMileagePhoto: false, awaitingManualMileage: false });
      clearState(ctx.from.id);
      await ctx.replyWithHTML('⏭️ Обработка отменена', getMenuForRole(ctx.from.id));
      return;
    }

    if (savedMileage) {
      clearState(ctx.from.id);
      await ctx.replyWithHTML('⬅️ Возвращаю в меню', getMenuForRole(ctx.from.id));
      return;
    }

    await ctx.replyWithHTML(
      '⚠️ Пропустить пробег?\n──────────────────────\n\nПробег не будет записан в таблицу.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, пропустить', 'confirm_skip_mileage')],
        [Markup.button.callback('❌ Отмена', 'cancel_skip_mileage')]
      ])
    );
  });

  bot.action('confirm_skip_mileage', async (ctx) => {
    await ctx.answerCbQuery('⏭️ Пропущено');
    clearState(ctx.from.id);
    console.log('пропуск пробега подтверждён');
    await ctx.replyWithHTML('⏭️ Пробег пропущен', getMenuForRole(ctx.from.id));
  });

  bot.action('cancel_skip_mileage', async (ctx) => {
    await ctx.answerCbQuery('Отменено');
    try { await ctx.deleteMessage(); } catch {}
  });

  bot.action('edit_mileage', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);

    if (!state?.mileageRow || !state?.day || !state?.stage) {
      await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.mileage}»`, getMenuForRole(ctx.from.id));
      return;
    }

    setState(ctx.from.id, { ...state, mileageProcessing: false, awaitingManualMileage: true, awaitingMileagePhoto: false });
    await ctx.replyWithHTML('✏️ Ввод пробега\n──────────────────────\n\nВведите пробег цифрами или загрузите фото повторно.', manualMileageKeyboard());
  });

  bot.action('edit_time', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);

    if (!state?.awaitingTimeChange || !state?.courierRow || !state?.day || !state?.stage) {
      await ctx.replyWithHTML(`⚠️ Сначала нажмите «${BUTTONS.punchTime}»`, getMenuForRole(ctx.from.id));
      return;
    }

    setState(ctx.from.id, {
      ...state,
      awaitingTimeChange: false,
      awaitingManualTime: true
    });

      await ctx.replyWithHTML(
        `✏️ Изменение времени\n` +
        `──────────────────────\n\n` +
        `Этап: <b>${esc(formatStage(state.stage))}</b>\n\n` +
        `Формат: <code>7</code>, <code>7,5</code>, <code>07:30</code>, <code>08:46</code>\n\n` +
        `Минуты округлятся до ближайших 30.`,
      getMenuForRole(ctx.from.id)
    );
  });
};
