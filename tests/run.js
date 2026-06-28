/**
 * Minimal zero-dependency test runner.
 */

const path = require('path');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, message) {
  if (!value) {
    throw new Error(message || 'expected truthy value');
  }
}

function assertFalse(value, message) {
  if (value) {
    throw new Error(message || 'expected falsy value');
  }
}

async function run() {
  // Load test suites
  require('./utils.test');
  require('./safeLog.test');
  require('./version.test');
  require('./reconciliationOcr.test');
  require('./miniAppAuth.test');
  require('./courierActions.test');

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = { test, assertEqual, assertTrue, assertFalse };

if (require.main === module) {
  run();
}
