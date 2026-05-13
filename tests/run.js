// Простой раннер тестов без сторонних зависимостей.
// Запуск: node tests/run.js
// Каждый test-файл экспортирует массив { name, fn } или объект { suite, tests }.

const fs = require('fs');
const path = require('path');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const useColor = process.stdout.isTTY;
const c = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function format(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

class Assert {
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message || 'equal'}: ожидали ${format(expected)}, получили ${format(actual)}`);
    }
  }
  deepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      throw new Error(`${message || 'deepEqual'}: ожидали ${format(expected)}, получили ${format(actual)}`);
    }
  }
  ok(value, message) {
    if (!value) {
      throw new Error(`${message || 'ok'}: ожидали truthy, получили ${format(value)}`);
    }
  }
  notOk(value, message) {
    if (value) {
      throw new Error(`${message || 'notOk'}: ожидали falsy, получили ${format(value)}`);
    }
  }
  throws(fn, message) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) {
      throw new Error(`${message || 'throws'}: функция должна была бросить исключение`);
    }
  }
  isNull(value, message) {
    if (value !== null) {
      throw new Error(`${message || 'isNull'}: ожидали null, получили ${format(value)}`);
    }
  }
}

const assert = new Assert();

function findTestFiles() {
  const dir = path.join(__dirname);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(dir, f));
}

async function runFile(filePath) {
  const exported = require(filePath);
  let suiteName = path.basename(filePath, '.test.js');
  let tests = [];

  if (Array.isArray(exported)) {
    tests = exported;
  } else if (exported && Array.isArray(exported.tests)) {
    suiteName = exported.suite || suiteName;
    tests = exported.tests;
  } else {
    throw new Error(`${filePath}: должен экспортировать массив или { suite, tests }`);
  }

  console.log(`\n${c(CYAN, '▶')} ${c(CYAN, suiteName)} ${c(DIM, `(${tests.length} тестов)`)}`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const test of tests) {
    try {
      await test.fn(assert);
      passed++;
      if (process.env.TEST_VERBOSE) {
        console.log(`  ${c(GREEN, '✓')} ${test.name}`);
      }
    } catch (error) {
      failed++;
      failures.push({ name: test.name, error });
      console.log(`  ${c(RED, '✗')} ${test.name}`);
      console.log(`    ${c(RED, error.message)}`);
    }
  }

  if (failed === 0) {
    console.log(`  ${c(GREEN, `✓ все ${passed} прошли`)}`);
  } else {
    console.log(`  ${c(RED, `✗ ${failed} из ${tests.length} провалились`)}`);
  }

  return { suiteName, passed, failed, total: tests.length };
}

async function main() {
  const files = findTestFiles();

  if (files.length === 0) {
    console.log(c(YELLOW, 'нет test-файлов в tests/'));
    process.exit(0);
  }

  console.log(`${c(DIM, '─'.repeat(50))}`);
  console.log(`${c(DIM, `Запуск ${files.length} файла(ов)`)}`);
  console.log(`${c(DIM, '─'.repeat(50))}`);

  const results = [];
  for (const file of files) {
    try {
      results.push(await runFile(file));
    } catch (error) {
      console.error(`\n${c(RED, '✗ ошибка загрузки')} ${file}`);
      console.error(c(RED, error.stack || error.message));
      results.push({ suiteName: path.basename(file), passed: 0, failed: 1, total: 1 });
    }
  }

  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const totalTests = results.reduce((sum, r) => sum + r.total, 0);

  console.log(`\n${c(DIM, '─'.repeat(50))}`);
  if (totalFailed === 0) {
    console.log(c(GREEN, `✓ Итого: ${totalPassed}/${totalTests} прошли`));
    process.exit(0);
  } else {
    console.log(c(RED, `✗ Итого: ${totalFailed} из ${totalTests} провалились (${totalPassed} прошли)`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(c(RED, 'fatal:'), error);
  process.exit(1);
});
