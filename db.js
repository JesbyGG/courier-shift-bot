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

  CREATE TABLE IF NOT EXISTS shop_status (
    workplace TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    updatedBy TEXT,
    updatedAt TEXT
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

module.exports = db;
