const db = require('./db');
const rows = db.prepare('SELECT * FROM message_threads').all();
console.log(JSON.stringify(rows, null, 2));
