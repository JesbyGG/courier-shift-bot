let _adminIdsRaw = null;
let _adminIdsCache = null;

function getAdminIds() {
  const raw = String(process.env.ADMIN_IDS || "");
  if (raw === _adminIdsRaw && _adminIdsCache) return _adminIdsCache;
  _adminIdsRaw = raw;
  _adminIdsCache = raw
    .split(",")
    .map((id) => String(id).trim())
    .filter((id) => /^[0-9]+$/.test(id));
  return _adminIdsCache;
}

function isAdminUser(telegramId) {
  const adminIds = getAdminIds();
  return adminIds.length > 0 && adminIds.includes(String(telegramId));
}

module.exports = {
  getAdminIds,
  isAdminUser,
};
