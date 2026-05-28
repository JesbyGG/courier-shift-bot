const db = require('./db');
const { Telegraf } = require('telegraf');

// We can't easily test botInfo without the actual bot instance,
// but let's verify the DB functions work correctly
console.log('=== Testing DB functions ===');

// Test with correct values
const thread1 = db.findThreadByGroupMessage('-1003935328410', 463);
console.log('Test 1 (correct):', thread1 ? 'FOUND' : 'NOT FOUND');

// Test with wrong message_id
const thread2 = db.findThreadByGroupMessage('-1003935328410', 999);
console.log('Test 2 (wrong msg_id):', thread2 ? 'FOUND' : 'NOT FOUND');

// Test with wrong chat_id
const thread3 = db.findThreadByGroupMessage('-999', 463);
console.log('Test 3 (wrong chat_id):', thread3 ? 'FOUND' : 'NOT FOUND');

console.log('=== All tests complete ===');
