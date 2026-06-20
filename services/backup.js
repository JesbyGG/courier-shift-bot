/**
 * Backup lifecycle: VACUUM INTO for SQLite, file copy for JSON assets,
 * retention cleanup.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const safeLog = require('../utils/safeLog');
const { LIMITS } = require('../config');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const BACKUP_FILES = ['database.sqlite', 'fun-reactions.json'];
const BACKUP_INTERVAL_MS = LIMITS.BACKUP_INTERVAL_MS;
const BACKUP_RETENTION_MS = LIMITS.BACKUP_RETENTION_MS;

async function ensureBackupDir() {
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  } catch (_) {}
}

async function makeBackup(reason = 'auto') {
  await ensureBackupDir();
  const now = new Date();
  const ts = now.toISOString().replace(/[.:]/g, '-');

  // Consistent SQLite backup via VACUUM INTO (atomic, includes WAL state)
  try {
    db.checkpoint();
    const sqliteDst = path.join(BACKUP_DIR, `database.sqlite-${reason}-${ts}.sqlite`);
    db.prepare(`VACUUM INTO ?`).run(sqliteDst);
  } catch (e) {
    safeLog.error('SQLite VACUUM INTO backup failed, falling back to copyFile:', e.message);
    const fallbackDst = path.join(BACKUP_DIR, `database.sqlite-${reason}-${ts}.sqlite`);
    try {
      await fs.promises.copyFile(path.join(__dirname, '..', 'database.sqlite'), fallbackDst);
    } catch (_) {}
  }

  for (const filename of BACKUP_FILES) {
    if (filename === 'database.sqlite') continue; // handled above
    const src = path.join(__dirname, '..', filename);
    try {
      await fs.promises.access(src);
      const dst = path.join(BACKUP_DIR, `${filename.replace('.json', '')}-${reason}-${ts}.json`);
      await fs.promises.copyFile(src, dst);
    } catch (_) {}
  }
}

async function cleanOldBackups() {
  const cutoff = Date.now() - BACKUP_RETENTION_MS;
  let entries;
  try {
    entries = await fs.promises.readdir(BACKUP_DIR);
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(BACKUP_DIR, entry);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(fullPath);
      }
    } catch (_) {}
  }
}

async function runBackupCycle() {
  try {
    db.checkpoint();
  } catch (_) {}
  await makeBackup('auto');
  await cleanOldBackups();
}

module.exports = {
  BACKUP_DIR,
  BACKUP_FILES,
  BACKUP_INTERVAL_MS,
  BACKUP_RETENTION_MS,
  ensureBackupDir,
  makeBackup,
  cleanOldBackups,
  runBackupCycle
};
