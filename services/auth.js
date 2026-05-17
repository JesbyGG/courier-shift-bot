let _adminIdsRaw = null;
let _adminIdsCache = null;

function getAdminIds() {
  const raw = String(process.env.ADMIN_IDS || '');
  if (raw === _adminIdsRaw && _adminIdsCache) return _adminIdsCache;
  _adminIdsRaw = raw;
  _adminIdsCache = raw.split(',').map((id) => Number(id.trim())).filter(Number.isFinite);
  return _adminIdsCache;
}

function isAdminUser(telegramId) {
  const adminIds = getAdminIds();
  return adminIds.length > 0 && adminIds.includes(Number(telegramId));
}

module.exports = {
  getAdminIds,
  isAdminUser
};
