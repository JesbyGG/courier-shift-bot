module.exports = function setupReplyForwarding(bot, services) {
  const {
    saveThread,
    findThreadByGroupMessage,
    findThreadById,
    saveForwardedMessage,
    findForwardedMessage,
    cleanupOldThreads
  } = services;

  const esc = services.esc || ((s) => String(s || '').replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])));

  let botId = null;

  // ─── Manager replies in group → forward to courier ───
  bot.on('message', async (ctx, next) => {
    if (!botId && bot.botInfo) botId = bot.botInfo.id;

    if (ctx.chat?.type === 'private') return next();
    if (!ctx.message?.reply_to_message) return next();

    const replyFromId = ctx.message.reply_to_message.from?.id;
    if (!botId || replyFromId !== botId) return next();

    const thread = findThreadByGroupMessage(ctx.chat.id, ctx.message.reply_to_message.message_id);
    if (!thread) return next();

    const courierId = Number(thread.courier_telegram_id);
    if (!courierId) return next();

    try {
      let result;
      const managerName = ctx.from?.first_name || 'Менеджер';
      const groupChatId = thread.group_chat_id;
      const groupMessageId = thread.group_message_id;

      // 1. Переслать оригинальное фото/сообщение из группы курьеру
      let forwardedOriginal = null;
      try {
        forwardedOriginal = await bot.telegram.forwardMessage(
          courierId,
          groupChatId,
          groupMessageId
        );
      } catch (e) {
        console.log('forward original failed:', e.message);
      }

      const sendOpts = { parse_mode: 'HTML' };
      if (forwardedOriginal) {
        sendOpts.reply_to_message_id = forwardedOriginal.message_id;
      }

      if (ctx.message.text) {
        const text = `📨 <b>${esc(managerName)}</b>:\n\n${esc(ctx.message.text)}`;
        result = await bot.telegram.sendMessage(courierId, text, sendOpts);
      } else if (ctx.message.photo) {
        const caption = `📨 <b>${esc(managerName)}</b>:`;
        result = await bot.telegram.sendPhoto(courierId, ctx.message.photo[ctx.message.photo.length - 1].file_id, {
          caption,
          parse_mode: 'HTML',
          reply_to_message_id: forwardedOriginal?.message_id
        });
      } else if (ctx.message.document) {
        const caption = `📨 <b>${esc(managerName)}</b>:`;
        result = await bot.telegram.sendDocument(courierId, ctx.message.document.file_id, {
          caption,
          parse_mode: 'HTML',
          reply_to_message_id: forwardedOriginal?.message_id
        });
      } else if (ctx.message.voice) {
        const caption = `📨 <b>${esc(managerName)}</b>:`;
        result = await bot.telegram.sendVoice(courierId, ctx.message.voice.file_id, {
          caption,
          parse_mode: 'HTML',
          reply_to_message_id: forwardedOriginal?.message_id
        });
      } else {
        result = await bot.telegram.sendMessage(courierId, `📨 <b>${esc(managerName)}</b>:`, sendOpts);
      }

      if (result) {
        saveForwardedMessage(courierId, result.message_id, thread.id, 'manager_to_courier');
        console.log('reply forward: manager → courier', { courierId, threadId: thread.id });
      }
    } catch (e) {
      console.error('reply forward manager→courier error:', e.message);
      try {
        await ctx.replyWithHTML(`⚠️ Не удалось доставить сообщение курьеру. Возможно, он заблокировал бота.`, {
          reply_to_message_id: ctx.message.message_id
        });
      } catch (_) {}
    }

    return;
  });

  // ─── Courier replies in private → forward to group ───
  bot.on('message', async (ctx, next) => {
    if (!botId && bot.botInfo) botId = bot.botInfo.id;

    if (ctx.chat?.type !== 'private') return next();
    if (!ctx.message?.reply_to_message) return next();
    if (!botId) return next();
    if (ctx.message.reply_to_message.from?.id !== botId) return next();

    const fwd = findForwardedMessage(ctx.chat.id, ctx.message.reply_to_message.message_id);
    if (!fwd || fwd.direction !== 'manager_to_courier') return next();

    const thread = findThreadById(fwd.thread_id);
    if (!thread) return next();

    const groupChatId = thread.group_chat_id;
    const groupMessageId = thread.group_message_id;
    const courierName = ctx.from?.first_name || 'Курьер';

    try {
      let result;

      if (ctx.message.text) {
        const text = `↩️ <b>Ответ ${esc(courierName)}:</b>\n\n${esc(ctx.message.text)}`;
        try {
          result = await bot.telegram.sendMessage(groupChatId, text, {
            parse_mode: 'HTML',
            reply_to_message_id: Number(groupMessageId)
          });
        } catch (replyErr) {
          result = await bot.telegram.sendMessage(groupChatId, text, { parse_mode: 'HTML' });
        }
      } else if (ctx.message.photo) {
        const caption = `↩️ <b>Фото от ${esc(courierName)}:</b>`;
        try {
          result = await bot.telegram.sendPhoto(groupChatId, ctx.message.photo[ctx.message.photo.length - 1].file_id, {
            caption,
            parse_mode: 'HTML',
            reply_to_message_id: Number(groupMessageId)
          });
        } catch (replyErr) {
          result = await bot.telegram.sendPhoto(groupChatId, ctx.message.photo[ctx.message.photo.length - 1].file_id, {
            caption,
            parse_mode: 'HTML'
          });
        }
      } else if (ctx.message.document) {
        const caption = `↩️ <b>Документ от ${esc(courierName)}:</b>`;
        try {
          result = await bot.telegram.sendDocument(groupChatId, ctx.message.document.file_id, {
            caption,
            parse_mode: 'HTML',
            reply_to_message_id: Number(groupMessageId)
          });
        } catch (replyErr) {
          result = await bot.telegram.sendDocument(groupChatId, ctx.message.document.file_id, {
            caption,
            parse_mode: 'HTML'
          });
        }
      } else if (ctx.message.voice) {
        const caption = `↩️ <b>Голосовое от ${esc(courierName)}:</b>`;
        try {
          result = await bot.telegram.sendVoice(groupChatId, ctx.message.voice.file_id, {
            caption,
            parse_mode: 'HTML',
            reply_to_message_id: Number(groupMessageId)
          });
        } catch (replyErr) {
          result = await bot.telegram.sendVoice(groupChatId, ctx.message.voice.file_id, {
            caption,
            parse_mode: 'HTML'
          });
        }
      } else {
        const text = `↩️ <b>Сообщение от ${esc(courierName)}:</b>`;
        try {
          result = await bot.telegram.sendMessage(groupChatId, text, {
            parse_mode: 'HTML',
            reply_to_message_id: Number(groupMessageId)
          });
        } catch (replyErr) {
          result = await bot.telegram.sendMessage(groupChatId, text, { parse_mode: 'HTML' });
        }
      }

      if (result) {
        saveForwardedMessage(groupChatId, result.message_id, thread.id, 'courier_to_group');
        console.log('reply forward: courier → group', { groupChatId, threadId: thread.id });

        // Подтверждение курьеру
        try {
          await bot.telegram.sendMessage(ctx.chat.id, '✅ <b>Ответ отправлен</b>', {
            parse_mode: 'HTML',
            reply_to_message_id: ctx.message.message_id
          });
        } catch (confirmErr) {
          console.log('confirmation send failed:', confirmErr.message);
        }
      }
    } catch (e) {
      console.error('reply forward courier→group error:', e.message);
      try {
        await bot.telegram.sendMessage(ctx.chat.id, '⚠️ Не удалось отправить ответ в группу. Возможно, бот удалён из чата.', {
          reply_to_message_id: ctx.message.message_id
        });
      } catch (_) {}
    }

    return;
  });
};
