const safeLog = require("../utils/safeLog");

const migrations = [require("./001_initial")];

function ensureSchemaVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);
}

function getCurrentVersion(db) {
  ensureSchemaVersionTable(db);
  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
  return row?.v || 0;
}

function recordVersion(db, version) {
  db.prepare("INSERT OR REPLACE INTO schema_version (version) VALUES (?)").run(
    version,
  );
}

function runMigrations(db) {
  const current = getCurrentVersion(db);
  safeLog.log(`current schema version: ${current}`);

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    try {
      safeLog.log(`running migration ${migration.version}: ${migration.name}`);
      migration.up(db);
      recordVersion(db, migration.version);
      safeLog.log(`migration ${migration.version} completed`);
    } catch (e) {
      safeLog.error(`migration ${migration.version} failed`, e.message);
      throw e;
    }
  }
}

module.exports = { runMigrations, getCurrentVersion };
