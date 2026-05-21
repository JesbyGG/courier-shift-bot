const Database = require('better-sqlite3');
const fs = require('fs');

// Backup current
if (fs.existsSync('database.sqlite')) {
  fs.copyFileSync('database.sqlite', 'database.sqlite.bak');
}

// Remove stale WAL/shm
fs.rmSync('database.sqlite-wal', { force: true });
fs.rmSync('database.sqlite-shm', { force: true });

try {
  const db = new Database('database.sqlite');
  db.pragma('journal_mode = WAL');
  db.prepare('SELECT 1').get();
  console.log('DB recovered OK, WAL mode restored');
  db.close();
} catch (e) {
  console.error('DB still corrupt:', e.message);
  process.exit(1);
}
