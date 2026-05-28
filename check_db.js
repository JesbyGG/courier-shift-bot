const db = require('./db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
console.log('Tables:', tables);
const threads = db.prepare('SELECT COUNT(*) as cnt FROM message_threads').get();
console.log('Threads count:', threads.cnt);
