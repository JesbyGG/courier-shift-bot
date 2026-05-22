const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const dbDir = __dirname;
const backupsDir = path.join(dbDir, 'backups');

function findLatestBackup() {
  if (!fs.existsSync(backupsDir)) return null;
  const files = fs.readdirSync(backupsDir)
    .filter(f => f.startsWith('database.sqlite-') && !f.endsWith('.shm') && !f.endsWith('.wal'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  return path.join(backupsDir, files[0]);
}

function tryRestoreFromBackup() {
  const backup = findLatestBackup();
  if (!backup) {
    console.error('No valid backup found, creating fresh database');
    return false;
  }
  console.log(`Attempting to restore from backup: ${path.basename(backup)}`);
  try {
    const tmpDb = new Database(backup);
    const result = tmpDb.pragma('integrity_check', { simple: true });
    tmpDb.close();
    if (result !== 'ok') {
      console.error(`Backup ${path.basename(backup)} is also corrupt, trying older backup`);
      const allFiles = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('database.sqlite-') && !f.endsWith('.shm') && !f.endsWith('.wal'))
        .sort()
        .reverse();
      for (const file of allFiles) {
        if (file === path.basename(backup)) continue;
        const filePath = path.join(backupsDir, file);
        try {
          const testDb = new Database(filePath);
          const r = testDb.pragma('integrity_check', { simple: true });
          testDb.close();
          if (r === 'ok') {
            console.log(`Found valid backup: ${file}`);
            fs.copyFileSync(filePath, dbPath);
            return true;
          }
        } catch (_) {}
      }
      return false;
    }
    fs.copyFileSync(backup, dbPath);
    console.log('Database restored from backup');
    return true;
  } catch (e) {
    console.error('Backup restore failed:', e.message);
    return false;
  }
}

function checkpointAndClose(db) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {}
  try {
    db.close();
  } catch (_) {}
  const shmPath = dbPath + '-shm';
  const walPath = dbPath + '-wal';
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
}

let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    console.error(`Database integrity check failed: ${integrity}. Attempting recovery...`);
    checkpointAndClose(db);
    if (tryRestoreFromBackup()) {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 1000');
      db.pragma('synchronous = NORMAL');
    } else {
      console.error('All backups corrupt, creating fresh database');
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 1000');
      db.pragma('synchronous = NORMAL');
    }
  }
} catch (e) {
  if (e.message.includes('corrupt') || e.message.includes('malformed')) {
    console.error(`Database corrupt on open: ${e.message}. Attempting recovery...`);
    const shmPath = dbPath + '-shm';
    const walPath = dbPath + '-wal';
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (tryRestoreFromBackup()) {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 1000');
      db.pragma('synchronous = NORMAL');
    } else {
      console.error('All backups corrupt, creating fresh database');
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 1000');
      db.pragma('synchronous = NORMAL');
    }
  } else {
    throw e;
  }
}

// Initialize tables
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 1000');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegramId TEXT PRIMARY KEY,
    data TEXT
  );
  
  CREATE TABLE IF NOT EXISTS states (
    telegramId TEXT PRIMARY KEY,
    data TEXT
  );
  
  CREATE TABLE IF NOT EXISTS leaderboard (
    telegramId TEXT PRIMARY KEY,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS cash_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    logistId TEXT,
    logistFio TEXT,
    courierId TEXT NOT NULL,
    courierFio TEXT NOT NULL,
    workplace TEXT NOT NULL,
    amount REAL NOT NULL,
    action TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_cash (
    telegramId TEXT PRIMARY KEY,
    amount REAL NOT NULL DEFAULT 0,
    formatted TEXT,
    orders INTEGER,
    workplace TEXT,
    sourceLabel TEXT,
    confirmationStatus TEXT,
    updatedAt TEXT,
    fileId TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pending_cash_workplace ON pending_cash(workplace);

  CREATE TABLE IF NOT EXISTS xp_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegramId TEXT,
    amount INTEGER,
    reason TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS user_achievements (
    telegramId TEXT,
    achievementId TEXT,
    unlockedAt TEXT,
    PRIMARY KEY (telegramId, achievementId)
  );

  CREATE TABLE IF NOT EXISTS challenges (
    weekId TEXT,
    telegramId TEXT,
    type TEXT,
    target INTEGER,
    current INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    reward INTEGER,
    PRIMARY KEY (weekId, telegramId, type)
  );

  CREATE TABLE IF NOT EXISTS streaks (
    telegramId TEXT PRIMARY KEY,
    currentStreak INTEGER,
    maxStreak INTEGER,
    lastShiftDate TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_orders (
    telegramId TEXT,
    date TEXT,
    orders INTEGER,
    PRIMARY KEY (telegramId, date)
  );

  CREATE INDEX IF NOT EXISTS idx_daily_orders_date ON daily_orders(date);

  CREATE TABLE IF NOT EXISTS pending_sheet_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheetId TEXT NOT NULL,
    range TEXT NOT NULL,
    value TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ocr_debug (
    fileName TEXT PRIMARY KEY,
    filePath TEXT,
    timestamp TEXT,
    telegramId TEXT,
    stage TEXT,
    workplace TEXT,
    fio TEXT,
    fileId TEXT,
    ocrResult REAL,
    userCorrectedValue REAL,
    status TEXT,
    sizeMb REAL
  );
`);

function checkpoint() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.error('WAL checkpoint failed:', e.message);
  }
}

// Proxy object that behaves like the original db instance
const dbProxy = new Proxy(db, {
  get(target, prop) {
    if (prop === 'checkpoint') return checkpoint;
    return target[prop];
  }
});

module.exports = dbProxy;
module.exports.checkpoint = checkpoint;
module.exports.db = db;
