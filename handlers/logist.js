module.exports = function setupLogist(bot, services) {
  const {
    pokeCourier,
    showCashHistoryForDate,
    getReminder,
    updateReminder,
    deleteReminder,
    getPendingCash,
    getUserField,
    setUserField,
    getUserRole,
    logCashAction,
    clearPendingCashAndReminders,
    setCashConfirmationStatus,
    esc,
    formatMoneyRu,
    getMenuForRole,
    Markup,
    sendFunReaction,
    styledButton,
    safeLog,
  } = services;

  bot.action(/^d_(\d+)$/, async (ctx) => {
    if (getUserRole(String(ctx.from.id)) !== "logist") {
      await ctx.answerCbQuery("⛔ Только логист.", { show_alert: true });
      return;
    }
    const courierId = ctx.match[1];
    await pokeCourier(ctx, courierId);
  });

  bot.action(/^ack_([0-9a-f]+)$/, async (ctx) => {
    const shortId = ctx.match[1];

    const reminder = getReminder(shortId);
    if (!reminder) {
      await ctx.answerCbQuery("⚠️ Напоминание устарело.", { show_alert: true });
      try {
        await ctx.editMessageText(
          "⚠️ Напоминание устарело или уже обработано.",
        );
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (String(ctx.from.id) !== String(reminder.courierId)) {
      await ctx.answerCbQuery("⛔ Это не ваше напоминание.", {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    if (!reminder) {
      try {
        await ctx.editMessageText(
          "⚠️ Напоминание устарело или уже обработано.",
        );
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (reminder.status !== "reminded" && reminder.status !== "acknowledged") {
      try {
        await ctx.editMessageText("⚠️ Напоминание уже обработано.");
      } catch (e) {
        /* ignore */
      }
      return;
    }

    updateReminder(shortId, { status: "acknowledged" });

    const courierFio = reminder.courierFio;
    const formatted = reminder.formatted;
    const logistId = reminder.logistId;

    logCashAction({
      logistId,
      logistFio: reminder.logistFio,
      courierId: reminder.courierId,
      courierFio,
      workplace: reminder.workplace,
      amount: reminder.amount,
      action: "acknowledged",
    });

    try {
      await ctx.editMessageText(
        `✅ Отметка получена. Когда сдадите — нажмите «Сдал».\n\n` +
          `💶 К сдаче: <code>${esc(formatted)}</code> ₽`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [styledButton("✅ Сдал", `c_${shortId}`, "success")],
            ],
          },
        },
      );
    } catch (e) {
      /* ignore */
    }

    try {
      await bot.telegram.sendMessage(
        logistId,
        `🏃 <b>${esc(courierFio)}</b> уже бежит сдавать <code>${esc(formatted)}</code> ₽`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      safeLog.error("failed to notify logist about acknowledgement", e.message);
    }
  });

  bot.action(/^c_([0-9a-f]+)$/, async (ctx) => {
    const shortId = ctx.match[1];

    const reminder = getReminder(shortId);
    if (!reminder) {
      await ctx.answerCbQuery("⚠️ Напоминание устарело.", { show_alert: true });
      try {
        await ctx.editMessageText(
          "⚠️ Напоминание устарело или уже обработано.",
        );
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (String(ctx.from.id) !== String(reminder.courierId)) {
      await ctx.answerCbQuery("⛔ Это не ваше напоминание.", {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    if (!reminder) {
      try {
        await ctx.editMessageText(
          "⚠️ Напоминание устарело или уже обработано.",
        );
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (reminder.status === "approved" || reminder.status === "declined") {
      try {
        await ctx.editMessageText("✅ Наличные уже обработаны.");
      } catch (e) {
        /* ignore */
      }
      return;
    }

    updateReminder(shortId, { status: "confirmed" });

    logCashAction({
      logistId: reminder.logistId,
      logistFio: reminder.logistFio,
      courierId: reminder.courierId,
      courierFio: reminder.courierFio,
      workplace: reminder.workplace,
      amount: reminder.amount,
      action: "confirmed",
    });

    try {
      await ctx.editMessageText("⏳ Логист проверяет...", {
        parse_mode: "HTML",
      });
    } catch (e) {
      /* ignore */
    }

    try {
      const sent = await bot.telegram.sendMessage(
        reminder.logistId,
        `✅ <b>${esc(reminder.courierFio)}</b> сдал <code>${esc(reminder.formatted)}</code> ₽\n\nПодтвердите сдачу:`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Подтвердить",
                  callback_data: `appr_${shortId}`,
                  style: "success",
                },
              ],
              [
                {
                  text: "❌ Отклонить",
                  callback_data: `decl_${shortId}`,
                  style: "danger",
                },
              ],
            ],
          },
        },
      );
      updateReminder(shortId, { logistMsgId: sent.message_id });
    } catch (e) {
      safeLog.error("failed to notify logist about confirmation", e.message);
    }
  });

  bot.action(/^appr_([0-9a-f]+)$/, async (ctx) => {
    const shortId = ctx.match[1];

    if (getUserRole(String(ctx.from.id)) !== "logist") {
      await ctx.answerCbQuery("⛔ Только логист может подтверждать сдачу.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery();

    const reminder = getReminder(shortId);
    if (!reminder) {
      try {
        await ctx.editMessageText("⚠️ Напоминание устарело.");
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (reminder.status !== "confirmed") {
      await ctx.answerCbQuery("⛔ Курьер ещё не подтвердил сдачу.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery();

    clearPendingCashAndReminders(reminder.courierId);

    logCashAction({
      logistId: reminder.logistId,
      logistFio: reminder.logistFio,
      courierId: reminder.courierId,
      courierFio: reminder.courierFio,
      workplace: reminder.workplace,
      amount: reminder.amount,
      action: "approved",
    });

    const curCash1 = Number(
      getUserField(reminder.courierId, "cashSubmits") || 0,
    );
    setUserField(reminder.courierId, "cashSubmits", curCash1 + 1);

    deleteReminder(shortId);

    try {
      await ctx.editMessageText(
        `✅ Подтверждено: <b>${esc(reminder.courierFio)}</b> сдал <code>${esc(reminder.formatted)}</code> ₽`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      /* ignore */
    }

    try {
      await bot.telegram.sendMessage(
        reminder.courierId,
        `✅ <b>${esc(reminder.logistFio)}</b> подтвердил сдачу <code>${esc(reminder.formatted)}</code> ₽\n\nСпасибо!`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      safeLog.error("failed to notify courier about approval", e.message);
    }

    await sendFunReaction(ctx, "success");
  });

  bot.action(/^decl_([0-9a-f]+)$/, async (ctx) => {
    const shortId = ctx.match[1];

    if (getUserRole(String(ctx.from.id)) !== "logist") {
      await ctx.answerCbQuery("⛔ Только логист может отклонять сдачу.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery();

    const reminder = getReminder(shortId);
    if (!reminder) {
      try {
        await ctx.editMessageText("⚠️ Напоминание устарело.");
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (reminder.status !== "confirmed") {
      await ctx.answerCbQuery("⛔ Курьер ещё не подтвердил сдачу.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery();

    logCashAction({
      logistId: reminder.logistId,
      logistFio: reminder.logistFio,
      courierId: reminder.courierId,
      courierFio: reminder.courierFio,
      workplace: reminder.workplace,
      amount: reminder.amount,
      action: "declined",
    });

    updateReminder(shortId, { status: "declined" });

    try {
      await ctx.editMessageText(
        `❌ Отклонено: <b>${esc(reminder.courierFio)}</b>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      /* ignore */
    }

    try {
      await bot.telegram.sendMessage(
        reminder.courierId,
        `❌ <b>${esc(reminder.logistFio)}</b> отклонил сдачу.\n\nПроверьте сумму и нажмите «Сдал» снова.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Сдал",
                  callback_data: `c_${shortId}`,
                  style: "success",
                },
              ],
            ],
          },
        },
      );
    } catch (e) {
      safeLog.error("failed to notify courier about decline", e.message);
    }
  });

  bot.action(/^sc_appr_(\d+)$/, async (ctx) => {
    const courierId = ctx.match[1];

    const pendingCash = getPendingCash(courierId);
    if (!pendingCash || pendingCash.confirmationStatus !== "awaiting") {
      await ctx.answerCbQuery("⚠️ Уже обработано другим логистом.");
      try {
        await ctx.editMessageText("✅ Уже подтверждено другим логистом.");
      } catch (e) {
        /* ignore */
      }
      return;
    }

    const approverId = String(ctx.from.id);

    if (approverId === courierId) {
      await ctx.answerCbQuery("⛔ Вы не можете подтвердить свою сдачу.");
      return;
    }
    if (getUserRole(approverId) !== "logist") {
      await ctx.answerCbQuery("⛔ Только логист может подтверждать сдачу.");
      return;
    }
    const approverWorkplace = getUserField(approverId, "workplace");
    const cashWorkplace =
      pendingCash.workplace || getUserField(courierId, "workplace") || "";
    if (approverWorkplace !== cashWorkplace) {
      await ctx.answerCbQuery("⛔ Вы не привязаны к этому магазину.");
      return;
    }

    await ctx.answerCbQuery("✅ Сдача подтверждена");

    const courierFio = getUserField(courierId, "fio") || "Неизвестный";
    const amount = Number(pendingCash.amount || 0);
    const formatted = pendingCash.formatted || formatMoneyRu(amount);
    const workplace =
      pendingCash.workplace ||
      getUserField(courierId, "workplace") ||
      "не указано";
    const logistId = approverId;
    const logistFio = getUserField(logistId, "fio") || "Логист";

    clearPendingCashAndReminders(courierId);

    const curCash2 = Number(getUserField(courierId, "cashSubmits") || 0);
    setUserField(courierId, "cashSubmits", curCash2 + 1);

    logCashAction({
      logistId,
      logistFio,
      courierId,
      courierFio,
      workplace,
      amount,
      action: "logist_approved",
    });

    try {
      await ctx.editMessageText(
        `✅ Подтверждено: <b>${esc(courierFio)}</b> сдал <code>${esc(formatted)}</code> ₽`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      /* ignore */
    }

    try {
      await bot.telegram.sendMessage(
        courierId,
        `✅ <b>${esc(logistFio)}</b> подтвердил сдачу <code>${esc(formatted)}</code> ₽\n\nСпасибо!`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      safeLog.error("failed to notify courier about sc approval", e.message);
    }
  });

  bot.action(/^sc_decl_(\d+)$/, async (ctx) => {
    const courierId = ctx.match[1];

    const pendingCash = getPendingCash(courierId);
    if (!pendingCash || pendingCash.confirmationStatus !== "awaiting") {
      await ctx.answerCbQuery("⚠️ Запрос уже обработан.");
      try {
        await ctx.editMessageText("⚠️ Запрос уже обработан.");
      } catch (e) {
        /* ignore */
      }
      return;
    }

    const declinerId = String(ctx.from.id);

    if (declinerId === courierId) {
      await ctx.answerCbQuery("⛔ Вы не можете отклонить свою сдачу.");
      return;
    }
    if (getUserRole(declinerId) !== "logist") {
      await ctx.answerCbQuery("⛔ Только логист может отклонять сдачу.");
      return;
    }
    const declinerWorkplace = getUserField(declinerId, "workplace");
    if (declinerWorkplace !== (pendingCash.workplace || "")) {
      await ctx.answerCbQuery("⛔ Вы не привязаны к этому магазину.");
      return;
    }

    await ctx.answerCbQuery("❌ Сдача отклонена");

    setCashConfirmationStatus(courierId, null);

    const courierFio = getUserField(courierId, "fio") || "Неизвестный";
    const logistId = declinerId;
    const logistFio = getUserField(logistId, "fio") || "Логист";

    logCashAction({
      logistId,
      logistFio,
      courierId,
      courierFio,
      workplace: pendingCash.workplace || "не указано",
      amount: Number(pendingCash.amount || 0),
      action: "declined",
    });

    try {
      await ctx.editMessageText(`❌ Отклонено: <b>${esc(courierFio)}</b>`, {
        parse_mode: "HTML",
      });
    } catch (e) {
      /* ignore */
    }

    try {
      await bot.telegram.sendMessage(
        courierId,
        `❌ <b>${esc(logistFio)}</b> отклонил сдачу.\n\nПроверьте сумму и попробуйте снова.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      safeLog.error("failed to notify courier about sc decline", e.message);
    }
  });

  bot.action(/^ch_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    if (getUserRole(String(ctx.from.id)) !== "logist") {
      await ctx.answerCbQuery("⛔ Нет доступа.", { show_alert: true });
      return;
    }
    const dateStr = ctx.match[1];
    await ctx.answerCbQuery();
    await showCashHistoryForDate(ctx, dateStr);
  });
};
