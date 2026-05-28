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

  // Store bot ID after launch
  let botId = null;
  bot.use(async (ctx, next) => {
    if (!botId && bot.botInfo) {
      botId = bot.botInfo.id;
      console.log('Reply forwarding bot ID set:', botId);
    }
    return next();
  });

  // ─── Manager replies in group → forward to courier ───
  bot.use(async (ctx, next) => {
    // Only process messages
    if (!ctx.message) return next();
    
    // Only groups
    if (ctx.chat?.type === 'private') return next();
    // Must be reply
    if (!ctx.message.reply_to_message) return next();
    // Must reply to our bot's message
    const replyFromId = ctx.message.reply_to_message.from?.id;
    if (!botId) {
      console.log('reply forward: botId not yet set, skipping');
      return next();
    }
    if (replyFromId !== botId) {
      console.log('reply forward: reply not to our message', { replyFromId, botId });
      return next();
    }

    const thread = findThreadByGroupMessage(ctx.chat.id, ctx.message.reply_to_message.message_id);
    console.log('reply forward thread:', thread ? { id: thread.id, courierId: thread.courier_telegram_id } : 'NOT FOUND');
    if (!thread) return next();

    const courierId = Number(thread.courier_telegram_id);
    if (!courierId) return next();

    try {
      let result;
      const managerName = ctx.from?.first_name || 'Менеджер';

      if (ctx.message.text) {
        const text = `📨 <b>${esc(managerName)}</b> по сверке:\n\n${esc(ctx.message.text)}`;
        result = await bot.telegram.sendMessage(courierId, text, { parse_mode: 'HTML' });
      } else if (ctx.message.photo) {
        const caption = `📨 <b>${esc(managerName)}</b> прислал фото`;
        result = await bot.telegram.sendPhoto(courierId, ctx.message.photo[ctx.message.photo.length - 1].file_id, {
          caption,
          parse_mode: 'HTML'
        });
      } else if (ctx.message.document) {
        const caption = `📨 <b>${esc(managerName)}</b> прислал документ`;
        result = await bot.telegram.sendDocument(courierId, ctx.message.document.file_id, {
          caption,
          parse_mode: 'HTML'
        });
      } else if (ctx.message.voice) {
        const caption = `📨 <b>${esc(managerName)}</b> прислал голосовое`;
        result = await bot.telegram.sendVoice(courierId, ctx.message.voice.file_id, {
          caption,
          parse_mode: 'HTML'
        });
      } else {
        result = await bot.telegram.sendMessage(courierId, `📨 <b>${esc(managerName)}</b> прислал сообщение`, { parse_mode: 'HTML' });
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
  });

  // ─── Courier replies in private → forward to group ───
  bot.use(async (ctx, next) => {
    // Only process messages
    if (!ctx.message) return next();
    
    // Only private chats
    if (ctx.chat?.type !== 'private') return next();
    // Must be reply to bot's message
    if (!ctx.message.reply_to_message) return next();
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
      }
    } catch (e) {
      console.error('reply forward courier→group error:', e.message);
      try {
        await bot.telegram.sendMessage(ctx.chat.id, '⚠️ Не удалось отправить ответ в группу. Возможно, бот удалён из чата.', {
          reply_to_message_id: ctx.message.message_id
        });
      } catch (_) {}
    }
  });

  // Export cleanup for use elsewhere
  bot.context = bot.context || {};
  bot.context.cleanupOldThreads = cleanupOldThreads;
};
