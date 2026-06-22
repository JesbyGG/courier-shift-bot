/**
 * Tests for reconciliation OCR cash parser.
 */

const { test, assertEqual } = require('./run');
const { extractCashFromGemini, parseMoneyRu } = require('../services/reconciliationOcr');

test('parseMoneyRu handles comma decimal', () => {
  assertEqual(parseMoneyRu('17 777,18'), 17777.18);
  assertEqual(parseMoneyRu('10 404,37'), 10404.37);
  assertEqual(parseMoneyRu('404,37'), 404.37);
});

test('parseMoneyRu handles dot decimal', () => {
  assertEqual(parseMoneyRu('17777.18'), 17777.18);
  assertEqual(parseMoneyRu('10404.37'), 10404.37);
});

test('parseMoneyRu handles ruble symbol', () => {
  assertEqual(parseMoneyRu('17 777,18 ₽'), 17777.18);
  assertEqual(parseMoneyRu('10 404,37₽'), 10404.37);
});

test('extractCashFromGemini parses structured CASH with thousands separator', () => {
  const result = extractCashFromGemini('CASH: 10 404,37 ORDERS: 22');
  assertEqual(result.amount, 10404.37);
  assertEqual(result.totalOrders, 22);
  assertEqual(result.valid, true);
});

test('extractCashFromGemini parses legacy format with thousands separator', () => {
  const result = extractCashFromGemini('Наличные 2 / 10 404,37 ORDERS: 22');
  assertEqual(result.amount, 10404.37);
  assertEqual(result.totalOrders, 22);
  assertEqual(result.valid, true);
});

test('extractCashFromGemini handles small amounts without thousands separator', () => {
  const result = extractCashFromGemini('CASH: 404,37 ORDERS: 5');
  assertEqual(result.amount, 404.37);
  assertEqual(result.totalOrders, 5);
  assertEqual(result.valid, true);
});

test('extractCashFromGemini returns zero for empty text', () => {
  const result = extractCashFromGemini('');
  assertEqual(result.amount, 0);
  assertEqual(result.valid, false);
  assertEqual(result.reason, 'empty_text');
});

test('extractCashFromGemini returns zero for CASH: 0', () => {
  const result = extractCashFromGemini('CASH: 0 ORDERS: 10');
  assertEqual(result.amount, 0);
  assertEqual(result.valid, false);
  assertEqual(result.reason, 'cash_zero');
});
