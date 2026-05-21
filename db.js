const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Initialize tables
db.pragma('journal_mode = WAL');

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
`);

// Migration logic
function migrateJsonToSqlite() {
  const usersPath = path.join(__dirname, 'users.json');
  if (fs.existsSync(usersPath)) {
    try {
      const content = fs.readFileSync(usersPath, 'utf8');
      const users = JSON.parse(content);
      const stmt = db.prepare('INSERT OR IGNORE INTO users (telegramId, data) VALUES (?, ?)');
      const insertMany = db.transaction((usersObj) => {
        for (const [id, data] of Object.entries(usersObj)) {
          stmt.run(id, JSON.stringify(data));
        }
      });
      insertMany(users);
      fs.renameSync(usersPath, usersPath + '.migrated');
      console.log('Migrated users.json to SQLite');
    } catch (e) {
      console.error('Migration error for users:', e);
    }
  }

  const statesPath = path.join(__dirname, 'states.json');
  if (fs.existsSync(statesPath)) {
    try {
      const content = fs.readFileSync(statesPath, 'utf8');
      const states = JSON.parse(content);
      const stmt = db.prepare('INSERT OR IGNORE INTO states (telegramId, data) VALUES (?, ?)');
      const insertMany = db.transaction((statesObj) => {
        for (const [id, data] of Object.entries(statesObj)) {
          stmt.run(id, JSON.stringify(data));
        }
      });
      insertMany(states);
      fs.renameSync(statesPath, statesPath + '.migrated');
      console.log('Migrated states.json to SQLite');
    } catch (e) {
      console.error('Migration error for states:', e);
    }
  }

  const lbPath = path.join(__dirname, 'leaderboard-cache.json');
  if (fs.existsSync(lbPath)) {
    try {
      const content = fs.readFileSync(lbPath, 'utf8');
      const cache = JSON.parse(content);
      const records = cache.records || {};
      const stmt = db.prepare('INSERT OR IGNORE INTO leaderboard (telegramId, data) VALUES (?, ?)');
      const insertMany = db.transaction((recordsObj) => {
        for (const [id, data] of Object.entries(recordsObj)) {
          stmt.run(id, JSON.stringify(data));
        }
      });
      insertMany(records);
      fs.renameSync(lbPath, lbPath + '.migrated');
      console.log('Migrated leaderboard-cache.json to SQLite');
    } catch (e) {
      console.error('Migration error for leaderboard:', e);
    }
  }
}

migrateJsonToSqlite();

// Migrate pendingCashToSubmit from users JSON blob to dedicated pending_cash table
function migratePendingCashToTable() {
  const rows = db.prepare('SELECT telegramId, data FROM users').all();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO pending_cash (telegramId, amount, formatted, orders, workplace, sourceLabel, confirmationStatus, updatedAt, fileId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      stmt.run(
        item.telegramId,
        item.amount,
        item.formatted,
        item.orders,
        item.workplace,
        item.sourceLabel,
        item.confirmationStatus,
        item.updatedAt,
        item.fileId
      );
    }
  });

  const items = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      const pcs = data.pendingCashToSubmit;
      if (pcs && Number(pcs.amount || 0) >= 1) {
        items.push({
          telegramId: row.telegramId,
          amount: Number(pcs.amount || 0),
          formatted: pcs.formatted || null,
          orders: pcs.orders || null,
          workplace: pcs.workplace || null,
          sourceLabel: pcs.sourceLabel || null,
          confirmationStatus: pcs.confirmationStatus || null,
          updatedAt: pcs.updatedAt || new Date().toISOString(),
          fileId: pcs.fileId || null
        });
      }
    } catch (e) { /* skip malformed */ }
  }

  if (items.length > 0) {
    insertMany(items);
    console.log(`Migrated ${items.length} pendingCash records to pending_cash table`);
  }
}

migratePendingCashToTable();

module.exports = db;
