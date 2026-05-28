const db = require('./db');

// Test findThreadByGroupMessage
const thread = db.findThreadByGroupMessage('-1003935328410', 463);
console.log('Thread found:', JSON.stringify(thread, null, 2));

// Test botInfo (we can't test this without the bot instance, but let's check if saveThread works)
console.log('saveThread function exists:', typeof db.saveThread === 'function');
console.log('findThreadByGroupMessage function exists:', typeof db.findThreadByGroupMessage === 'function');
