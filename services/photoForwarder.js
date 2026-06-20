/**
 * Photo forwarding helpers.
 * Unified forwarding of single photos and media groups to configured
 * Telegram chats (work, route sheet, reconciliation).
 */

const db = require('../db');
const safeLog = require('../utils/safeLog');

async function sendPhotoToChat(ctx, fileId, caption, { envChatId, envThreadId, parseMode, fallbackChatId } = {}) {
  let chatId = envChatId ? process.env[envChatId] : null;

  if (!chatId && fallbackChatId) {
    chatId = fallbackChatId;
  }

  if (!chatId) {
    safeLog.log(`${envChatId || 'chatId'} is empty, photo is not forwarded`);
    return null;
  }

  const options = { caption };

  if (parseMode) {
    options.parse_mode = parseMode;
  }

  const threadId = envThreadId ? process.env[envThreadId] : null;
  if (threadId) {
    options.message_thread_id = Number(threadId);
  }

  // Clear any stale reply keyboard in group chats
  options.reply_markup = { remove_keyboard: true };

  try {
    const result = await ctx.telegram.sendPhoto(chatId, fileId, options);
    return result;
  } catch (error) {
    safeLog.error('telegram sendPhoto error', error?.message || error);
    return null;
  }
}

async function sendMediaGroupToChat(ctx, items, { envChatId, envThreadId, parseMode, fallbackChatId } = {}) {
  let chatId = envChatId ? process.env[envChatId] : null;

  if (!chatId && fallbackChatId) {
    chatId = fallbackChatId;
  }

  if (!chatId) {
    safeLog.log(`${envChatId || 'chatId'} is empty, media group is not forwarded`);
    return null;
  }

  const media = items.map((item, index) => {
    const entry = {
      type: 'photo',
      media: item.fileId
    };
    if (index === 0 && item.caption) {
      entry.caption = item.caption;
      if (parseMode) {
        entry.parse_mode = parseMode;
      }
    }
    return entry;
  });

  const options = {};
  const threadId = envThreadId ? process.env[envThreadId] : null;
  if (threadId) {
    options.message_thread_id = Number(threadId);
  }

  try {
    const result = await ctx.telegram.sendMediaGroup(chatId, media, options);

    // Clear any stale reply keyboard in group chats
    try {
      const cleanupMsg = await ctx.telegram.sendMessage(chatId, '', {
        reply_markup: { remove_keyboard: true },
        message_thread_id: threadId ? Number(threadId) : undefined
      });
      await ctx.telegram.deleteMessage(chatId, cleanupMsg.message_id).catch(() => {});
    } catch (_) {}

    return result;
  } catch (error) {
    safeLog.error('telegram sendMediaGroup error', error?.message || error);
    return null;
  }
}

// Конфиг назначений фото — единая таблица. Если появится новый чат
// (например, для штрафов), добавить запись и одну функцию-обёртку.
const PHOTO_DESTINATIONS = {
  work: {
    envChatId: 'WORK_CHAT_ID',
    envThreadId: 'WORK_THREAD_ID',
    parseMode: 'HTML'
  },
  routeSheet: {
    envChatId: 'ROUTE_SHEET_CHAT_ID',
    envThreadId: 'ROUTE_SHEET_THREAD_ID',
    fallbackEnvChatId: 'WORK_CHAT_ID',
    parseMode: 'HTML'
  },
  reconciliation: {
    envChatId: 'RECONCILIATION_CHAT_ID',
    envThreadId: 'RECONCILIATION_THREAD_ID',
    fallbackEnvChatId: 'WORK_CHAT_ID',
    parseMode: 'HTML'
  }
};

function forwardPhoto(ctx, fileId, caption, destinationKey) {
  const dest = PHOTO_DESTINATIONS[destinationKey];
  if (!dest) {
    safeLog.error('forwardPhoto: unknown destination', destinationKey);
    return Promise.resolve(null);
  }
  return sendPhotoToChat(ctx, fileId, caption, {
    envChatId: dest.envChatId,
    envThreadId: dest.envThreadId,
    parseMode: dest.parseMode,
    fallbackChatId: dest.fallbackEnvChatId ? process.env[dest.fallbackEnvChatId] : undefined
  });
}

const sendPhotoToWorkChat = (ctx, fileId, caption) => forwardPhoto(ctx, fileId, caption, 'work');
const sendPhotoToRouteSheetChat = (ctx, fileId, caption) => forwardPhoto(ctx, fileId, caption, 'routeSheet');
const sendPhotoToReconciliationChat = (ctx, fileId, caption) => forwardPhoto(ctx, fileId, caption, 'reconciliation');

function forwardMediaGroup(ctx, items, destinationKey) {
  const dest = PHOTO_DESTINATIONS[destinationKey];
  if (!dest) {
    safeLog.error('forwardMediaGroup: unknown destination', destinationKey);
    return Promise.resolve(null);
  }
  return sendMediaGroupToChat(ctx, items, {
    envChatId: dest.envChatId,
    envThreadId: dest.envThreadId,
    parseMode: dest.parseMode,
    fallbackChatId: dest.fallbackEnvChatId ? process.env[dest.fallbackEnvChatId] : undefined
  });
}

function savePhotoThread(result, telegramId, type) {
  if (!result || !result.chat || !result.message_id || !telegramId) return;
  db.saveThread(result.chat.id, result.message_id, telegramId, type, result.message_thread_id);
  db.cleanupOldThreads(7);
}

const sendMediaGroupToReconciliationChat = (ctx, items) => forwardMediaGroup(ctx, items, 'reconciliation');

module.exports = {
  PHOTO_DESTINATIONS,
  sendPhotoToChat,
  sendMediaGroupToChat,
  forwardPhoto,
  forwardMediaGroup,
  sendPhotoToWorkChat,
  sendPhotoToRouteSheetChat,
  sendPhotoToReconciliationChat,
  sendMediaGroupToReconciliationChat,
  savePhotoThread
};
