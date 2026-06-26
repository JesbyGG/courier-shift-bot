const fs = require("fs");
const path = require("path");
const safeLog = require("../utils/safeLog");
const replyManager = require("./replyManager");
const { LIMITS } = require("../config");

const funReactionsPath = path.join(__dirname, "..", "fun-reactions.json");
const FUN_REACTION_CLEANUP_INTERVAL = LIMITS.FUN_REACTION_CLEANUP_INTERVAL_MS;
let funReactionCleanupTimer = null;

const SUCCESS_STICKER_EMOJIS = new Set([
  "😀",
  "😁",
  "😄",
  "😎",
  "🥳",
  "🎉",
  "✨",
  "🔥",
  "💪",
  "👍",
  "👏",
  "✅",
]);

const ERROR_STICKER_EMOJIS = new Set([
  "😢",
  "😭",
  "😿",
  "😞",
  "😣",
  "😫",
  "🤦",
  "🙈",
  "😡",
  "😤",
  "🚫",
  "❌",
  "⚠️",
]);

let funReactionsCache = null;
let funReactionsWriteQueue = Promise.resolve();

function parseEnvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickRandom(items) {
  if (!items || items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function mergeUniqueItems(...lists) {
  const result = [];
  const seen = new Set();

  for (const list of lists) {
    for (const item of list || []) {
      const value = String(item || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
  }

  return result;
}

function normalizeFunList(value, limit = 800) {
  return mergeUniqueItems(value).slice(0, limit);
}

function normalizeImportedStickerSets(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};

  for (const [name, meta] of Object.entries(source)) {
    const setName = String(name || "").trim();
    if (!setName) continue;
    result[setName] = {
      importedAt: String(meta?.importedAt || ""),
      total: Number(meta?.total || 0),
    };
  }

  return result;
}

function getEmptyFunReactions() {
  return {
    successStickers: [],
    errorStickers: [],
    neutralStickers: [],
    successGifs: [],
    errorGifs: [],
    neutralGifs: [],
    importedStickerSets: {},
  };
}

function normalizeFunReactionsData(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    successStickers: normalizeFunList(source.successStickers),
    errorStickers: normalizeFunList(source.errorStickers),
    neutralStickers: normalizeFunList(source.neutralStickers),
    successGifs: normalizeFunList(source.successGifs, 300),
    errorGifs: normalizeFunList(source.errorGifs, 300),
    neutralGifs: normalizeFunList(source.neutralGifs, 300),
    importedStickerSets: normalizeImportedStickerSets(
      source.importedStickerSets,
    ),
  };
}

function loadFunReactions() {
  if (funReactionsCache) return funReactionsCache;

  try {
    if (!fs.existsSync(funReactionsPath)) {
      funReactionsCache = getEmptyFunReactions();
      return funReactionsCache;
    }

    const data = JSON.parse(fs.readFileSync(funReactionsPath, "utf8"));
    funReactionsCache = normalizeFunReactionsData(data);
    return funReactionsCache;
  } catch (error) {
    safeLog.error("fun reactions load error", error.message);
    funReactionsCache = getEmptyFunReactions();
    return funReactionsCache;
  }
}

function scheduleFunReactionsWrite() {
  funReactionsWriteQueue = funReactionsWriteQueue.then(async () => {
    try {
      await fs.promises.writeFile(
        funReactionsPath,
        JSON.stringify(funReactionsCache || getEmptyFunReactions(), null, 2),
        "utf8",
      );
    } catch (error) {
      safeLog.error("fun reactions write error", error.message);
    }
  });
}

function flushFunReactionsNow() {
  funReactionsWriteQueue = funReactionsWriteQueue.then(async () => {
    try {
      await fs.promises.writeFile(
        funReactionsPath,
        JSON.stringify(funReactionsCache || getEmptyFunReactions(), null, 2),
        "utf8",
      );
    } catch (error) {
      safeLog.error("fun reactions flush error", error.message);
    }
  });
}

function addUniqueLimited(list, value, limit = 800) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (list.includes(text)) return false;

  list.push(text);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }

  return true;
}

function getStickerReactionTypeByEmoji(emoji) {
  const value = String(emoji || "").trim();
  if (!value) return "neutral";
  if (ERROR_STICKER_EMOJIS.has(value)) return "error";
  if (SUCCESS_STICKER_EMOJIS.has(value)) return "success";
  return "neutral";
}

function getStickerBucketByType(reactionType) {
  if (reactionType === "error") return "errorStickers";
  if (reactionType === "success") return "successStickers";
  return "neutralStickers";
}

function getGifBucketByType(reactionType) {
  if (reactionType === "error") return "errorGifs";
  if (reactionType === "success") return "successGifs";
  return "neutralGifs";
}

function saveFunSticker(fileId, reactionType = "neutral") {
  const data = loadFunReactions();
  const bucket = getStickerBucketByType(reactionType);
  const changed = addUniqueLimited(data[bucket], fileId, 1000);

  if (changed) {
    scheduleFunReactionsWrite();
  }

  return changed;
}

function saveFunGif(fileId, reactionType = "neutral") {
  const data = loadFunReactions();
  const bucket = getGifBucketByType(reactionType);
  const changed = addUniqueLimited(data[bucket], fileId, 400);

  if (changed) {
    scheduleFunReactionsWrite();
  }

  return changed;
}

function extractStickerSetName(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  const match = value.match(
    /(?:https?:\/\/)?t\.me\/addstickers\/([a-zA-Z0-9_]+)/i,
  );
  if (match) return match[1];

  if (/^[a-zA-Z0-9_]+$/.test(value)) return value;
  return null;
}

function isFunStickerSetImportEnabled() {
  return (
    String(process.env.FUN_IMPORT_STICKER_SETS || "true").toLowerCase() !==
    "false"
  );
}

function getConfiguredFunStickerSetNames() {
  const envItems = parseEnvList(process.env.FUN_STICKER_SETS);
  const defaults = [
    "https://t.me/addstickers/TikTok_cats_animals",
    "https://t.me/addstickers/babylka_mem",
  ];
  const sources = envItems.length > 0 ? envItems : defaults;

  return mergeUniqueItems(
    sources.map((item) => extractStickerSetName(item)).filter(Boolean),
  );
}

async function importStickerSetForFunReactions(ctx, stickerSetName) {
  const setName = extractStickerSetName(stickerSetName);
  if (!setName || !isFunStickerSetImportEnabled()) {
    return { setName, imported: false, added: 0, total: 0 };
  }

  const data = loadFunReactions();
  if (data.importedStickerSets[setName]) {
    return {
      setName,
      imported: false,
      added: 0,
      total: data.importedStickerSets[setName].total || 0,
    };
  }

  try {
    const stickerSet = await ctx.telegram.getStickerSet(setName);
    const stickers = Array.isArray(stickerSet?.stickers)
      ? stickerSet.stickers
      : [];
    let added = 0;

    for (const sticker of stickers) {
      if (!sticker?.file_id) continue;
      const reactionType = getStickerReactionTypeByEmoji(sticker.emoji);
      if (saveFunSticker(sticker.file_id, reactionType)) {
        added++;
      }
    }

    data.importedStickerSets[setName] = {
      importedAt: new Date().toISOString(),
      total: stickers.length,
    };
    scheduleFunReactionsWrite();
    safeLog.log(
      `fun stickers imported: ${setName}, total=${stickers.length}, added=${added}`,
    );

    return { setName, imported: true, added, total: stickers.length };
  } catch (error) {
    safeLog.error("fun sticker set import error", setName, error.message);
    return {
      setName,
      imported: false,
      added: 0,
      total: 0,
      error: error.message,
    };
  }
}

async function importConfiguredFunStickerSets(ctx) {
  if (!isFunStickerSetImportEnabled()) return;

  const setNames = getConfiguredFunStickerSetNames();
  for (const setName of setNames) {
    await importStickerSetForFunReactions(ctx, setName);
  }
}

function hasAnyFunReactionContent() {
  const envContent = [
    ...parseEnvList(process.env.FUN_ERROR_STICKERS),
    ...parseEnvList(process.env.FUN_SUCCESS_STICKERS),
    ...parseEnvList(process.env.FUN_ERROR_GIFS),
    ...parseEnvList(process.env.FUN_SUCCESS_GIFS),
  ];

  if (envContent.length > 0) return true;

  const stored = loadFunReactions();
  return (
    stored.successStickers.length > 0 ||
    stored.errorStickers.length > 0 ||
    stored.neutralStickers.length > 0 ||
    stored.successGifs.length > 0 ||
    stored.errorGifs.length > 0 ||
    stored.neutralGifs.length > 0
  );
}

function isFunReactionsEnabled() {
  const flag = String(process.env.FUN_REACTIONS_ENABLED || "")
    .trim()
    .toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return true;
  if (flag === "false" || flag === "0" || flag === "no") return false;
  return hasAnyFunReactionContent();
}

function getFunReactionTypeFromMessage(htmlText) {
  const plainText = String(htmlText || "")
    .replace(/<[^>]*>/g, "")
    .trim();

  if (plainText.startsWith("✅")) return "success";
  if (plainText.startsWith("❌") || plainText.startsWith("⚠️")) return "error";
  return null;
}

function getFunReactionCooldownMs() {
  const value = Number(process.env.FUN_REACTION_COOLDOWN_MS || 30000);
  return Number.isFinite(value) && value >= 0 ? value : 30000;
}

function canSendFunReaction(chatId) {
  const cooldown = getFunReactionCooldownMs();
  if (cooldown === 0) return true;

  const now = Date.now();
  const last = replyManager.getFunReactionCooldown(chatId) || 0;
  if (now - last < cooldown) return false;

  replyManager.setFunReactionCooldown(chatId, now);
  return true;
}

async function sendFunReaction(ctx, reactionType, replyMarkup = null) {
  if (!isFunReactionsEnabled() && !replyMarkup) return;
  const chatId = ctx?.chat?.id;
  if (!chatId) return;
  if (!canSendFunReaction(chatId) && !replyMarkup) return;

  const envStickerList =
    reactionType === "error"
      ? parseEnvList(process.env.FUN_ERROR_STICKERS)
      : parseEnvList(process.env.FUN_SUCCESS_STICKERS);
  const envGifList =
    reactionType === "error"
      ? parseEnvList(process.env.FUN_ERROR_GIFS)
      : parseEnvList(process.env.FUN_SUCCESS_GIFS);

  const stored = loadFunReactions();
  const storedStickerList =
    reactionType === "error"
      ? mergeUniqueItems(stored.errorStickers, stored.neutralStickers)
      : mergeUniqueItems(stored.successStickers, stored.neutralStickers);
  const storedGifList =
    reactionType === "error"
      ? mergeUniqueItems(stored.errorGifs, stored.neutralGifs)
      : mergeUniqueItems(stored.successGifs, stored.neutralGifs);

  const stickerList = mergeUniqueItems(envStickerList, storedStickerList);
  const gifList = mergeUniqueItems(envGifList, storedGifList);

  const sticker = pickRandom(stickerList);
  const gif = pickRandom(gifList);

  const extra = replyMarkup
    ? { reply_markup: replyMarkup, disable_notification: true }
    : null;

  let sent = false;
  try {
    if (sticker) {
      await ctx.telegram.sendSticker(chatId, sticker, extra || {});
      sent = true;
    } else if (gif) {
      await ctx.telegram.sendAnimation(chatId, gif, extra || {});
      sent = true;
    }
  } catch (error) {
    safeLog.error("fun reaction error", error.message);
  }
  replyManager.setFunReactionCooldown(chatId, Date.now());

  if (replyMarkup && !sent) {
    await ctx.telegram
      .sendMessage(chatId, "•", {
        disable_notification: true,
        reply_markup: replyMarkup,
      })
      .catch(() => {});
  }
}

async function maybeSendFunReaction(ctx, htmlText) {
  const reactionType = getFunReactionTypeFromMessage(htmlText);
  if (!reactionType) return;
  await sendFunReaction(ctx, reactionType);
}

function cleanupFunReactionCooldowns() {
  replyManager.cleanupOldFunReactionCooldowns();
}

function startFunReactionCleanup() {
  if (!funReactionCleanupTimer) {
    funReactionCleanupTimer = setInterval(
      cleanupFunReactionCooldowns,
      FUN_REACTION_CLEANUP_INTERVAL,
    );
    funReactionCleanupTimer.unref();
  }
}

startFunReactionCleanup();

module.exports = {
  loadFunReactions,
  scheduleFunReactionsWrite,
  flushFunReactionsNow,
  saveFunSticker,
  saveFunGif,
  importStickerSetForFunReactions,
  importConfiguredFunStickerSets,
  isFunReactionsEnabled,
  getFunReactionTypeFromMessage,
  getStickerReactionTypeByEmoji,
  getFunReactionCooldownMs,
  canSendFunReaction,
  sendFunReaction,
  maybeSendFunReaction,
  cleanupFunReactionCooldowns,
  startFunReactionCleanup,
};
