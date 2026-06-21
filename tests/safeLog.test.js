/**
 * Tests for PII redaction logger.
 */

const { test, assertEqual, assertTrue } = require('./run');
const { redact } = require('../utils/safeLog');

test('redact masks email addresses', () => {
  assertTrue(redact('contact me at user@example.com please').includes('[EMAIL]'));
});

test('redact masks phone numbers', () => {
  assertTrue(redact('call +7 999 123-45-67').includes('[PHONE]'));
});

test('redact masks bot tokens', () => {
  assertTrue(redact('token 123456:ABC-DEF12345ghijklmnopqrstuvwxyz12').includes('[BOT_TOKEN]'));
});

test('redact masks standalone numeric IDs / phones', () => {
  assertTrue(redact('user id 1234567890').includes('[PHONE]'));
});

test('redact preserves normal text', () => {
  assertEqual(redact('hello world'), 'hello world');
});
