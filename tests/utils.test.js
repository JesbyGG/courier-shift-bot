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
