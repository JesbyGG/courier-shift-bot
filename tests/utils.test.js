/**
 * Tests for shared utilities.
 */

const { test, assertEqual, assertTrue, assertFalse } = require('./run');
const {
  getCurrentDateInfo,
  getColumnLetter,
  roundMinutesToHalfHour,
  roundTimeToHalfHour,
  isEmptyCell,
  isScheduleMarker
} = require('../utils');

test('getColumnLetter returns A for 1', () => {
  assertEqual(getColumnLetter(1), 'A');
});

test('getColumnLetter returns Z for 26', () => {
  assertEqual(getColumnLetter(26), 'Z');
});

test('getColumnLetter returns AA for 27', () => {
  assertEqual(getColumnLetter(27), 'AA');
});

test('roundMinutesToHalfHour rounds down to half hour', () => {
  assertEqual(roundMinutesToHalfHour(10, 20), '10,5');
  assertEqual(roundMinutesToHalfHour(0, 10), '0,0');
  assertEqual(roundMinutesToHalfHour(23, 40), '23,5');
});

test('roundTimeToHalfHour formats time correctly', () => {
  assertEqual(roundTimeToHalfHour(new Date(2024, 0, 1, 10, 20)), '10,5');
  assertEqual(roundTimeToHalfHour(new Date(2024, 0, 1, 0, 10)), '0,0');
});

test('isEmptyCell recognizes empty values', () => {
  assertTrue(isEmptyCell(''));
  assertTrue(isEmptyCell(null));
  assertTrue(isEmptyCell(undefined));
  assertFalse(isEmptyCell('0'));
  assertFalse(isEmptyCell('1'));
});

test('isScheduleMarker recognizes marker', () => {
  assertTrue(isScheduleMarker('1'));
  assertFalse(isScheduleMarker('0'));
  assertFalse(isScheduleMarker('2'));
});

test('roundTimeToHalfHour accepts timezone parts object', () => {
  assertEqual(roundTimeToHalfHour({ hour: 9, minute: 10 }), '9');
  assertEqual(roundTimeToHalfHour({ hour: 9, minute: 20 }), '9,5');
  assertEqual(roundTimeToHalfHour({ hour: 0, minute: 10 }), '0,0');
});

test('getCurrentDateInfo returns timezone-aware parts', () => {
  const info = getCurrentDateInfo('Europe/Moscow');
  assertTrue(Number.isFinite(info.year));
  assertTrue(Number.isFinite(info.month));
  assertTrue(Number.isFinite(info.day));
  assertTrue(Number.isFinite(info.hour));
  assertTrue(Number.isFinite(info.minute));
  assertTrue(info.month >= 1 && info.month <= 12);
  assertTrue(info.day >= 1 && info.day <= 31);
  assertTrue(info.hour >= 0 && info.hour <= 23);
});

test('getCurrentDateInfo with overrideDate respects timezone', () => {
  // 2024-01-15T06:00:00Z is 09:00 in Moscow (UTC+3)
  const info = getCurrentDateInfo('Europe/Moscow', '2024-01-15T06:00:00Z');
  assertEqual(info.year, 2024);
  assertEqual(info.month, 1);
  assertEqual(info.day, 15);
  assertEqual(info.hour, 9);
});
