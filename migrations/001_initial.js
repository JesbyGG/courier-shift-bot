const safeLog = require("../utils/safeLog");

module.exports = {
  version: 1,
  name: "initial schema fixes",
  up(db) {
    const threadCols = db.prepare("PRAGMA table_info(message_threads)").all();
    const hasMessageThreadId = threadCols.some(
      (c) => c.name === "message_thread_id",
    );
    if (!hasMessageThreadId) {
      db.prepare(
        "ALTER TABLE message_threads ADD COLUMN message_thread_id INTEGER",
      ).run();
      safeLog.log("migrated message_threads: added message_thread_id column");
    }

    const cols = db.prepare("PRAGMA table_info(pending_sheet_updates)").all();
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("attempts")) {
      db.prepare(
        "ALTER TABLE pending_sheet_updates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      ).run();
      safeLog.log("migrated pending_sheet_updates: added attempts column");
    }
    if (!colNames.has("lastAttemptAt")) {
      db.prepare(
        "ALTER TABLE pending_sheet_updates ADD COLUMN lastAttemptAt TEXT",
      ).run();
      safeLog.log("migrated pending_sheet_updates: added lastAttemptAt column");
    }
  },
};
