const db = require("../db");
const safeLog = require("../utils/safeLog");

const MAX_BOT_MESSAGE_CACHE = 1000;
const COOLDOWN_TTL_MS = 24 * 60 * 60 * 1000;

function initReplyManagerTables() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_messages (
        telegramId TEXT PRIMARY KEY,
        messageId INTEGER NOT NULL,
        hasKeyboard INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS fun_reaction_cooldowns (
        chatId TEXT PRIMARY KEY,
        lastReactionAt INTEGER NOT NULL
      );
    `);
  } catch (e) {
    safeLog.error("reply manager init error", e.message);
  }
}

initReplyManagerTables();

function getLastBotMessage(telegramId) {
  try {
    const row = db
      .prepare(
        "SELECT messageId, hasKeyboard FROM bot_messages WHERE telegramId = ?",
      )
      .get(String(telegramId));
    if (!row) return null;
    return { msgId: row.messageId, hasKeyboard: Boolean(row.hasKeyboard) };
  } catch (e) {
    safeLog.error("getLastBotMessage error", e.message);
    return null;
  }
}

function setLastBotMessage(telegramId, messageId, hasKeyboard) {
  try {
    const count = db.prepare("SELECT COUNT(*) as c FROM bot_messages").get().c;
    if (count >= MAX_BOT_MESSAGE_CACHE) {
      db.prepare(
        `DELETE FROM bot_messages WHERE telegramId IN (
        SELECT telegramId FROM bot_messages ORDER BY createdAt ASC LIMIT ?
      )`,
      ).run(count - MAX_BOT_MESSAGE_CACHE + 1);
    }
    db.prepare(
      `
      INSERT OR REPLACE INTO bot_messages (telegramId, messageId, hasKeyboard, createdAt)
      VALUES (?, ?, ?, datetime('now'))
    `,
    ).run(String(telegramId), Number(messageId), hasKeyboard ? 1 : 0);
  } catch (e) {
    safeLog.error("setLastBotMessage error", e.message);
  }
}

function deleteLastBotMessage(telegramId) {
  try {
    db.prepare("DELETE FROM bot_messages WHERE telegramId = ?").run(
      String(telegramId),
    );
  } catch (e) {
    safeLog.error("deleteLastBotMessage error", e.message);
  }
}

function getFunReactionCooldown(chatId) {
  try {
    const row = db
      .prepare(
        "SELECT lastReactionAt FROM fun_reaction_cooldowns WHERE chatId = ?",
      )
      .get(String(chatId));
    return row ? row.lastReactionAt : 0;
  } catch (e) {
    safeLog.error("getFunReactionCooldown error", e.message);
    return 0;
  }
}

function setFunReactionCooldown(chatId, timestamp) {
  try {
    db.prepare(
      `
      INSERT OR REPLACE INTO fun_reaction_cooldowns (chatId, lastReactionAt)
      VALUES (?, ?)
    `,
    ).run(String(chatId), Number(timestamp));
  } catch (e) {
    safeLog.error("setFunReactionCooldown error", e.message);
  }
}

function cleanupOldFunReactionCooldowns() {
  try {
    const cutoff = Date.now() - COOLDOWN_TTL_MS;
    db.prepare(
      "DELETE FROM fun_reaction_cooldowns WHERE lastReactionAt < ?",
    ).run(cutoff);
  } catch (e) {
    safeLog.error("cleanupOldFunReactionCooldowns error", e.message);
  }
}

module.exports = {
  getLastBotMessage,
  setLastBotMessage,
  deleteLastBotMessage,
  getFunReactionCooldown,
  setFunReactionCooldown,
  cleanupOldFunReactionCooldowns,
};
