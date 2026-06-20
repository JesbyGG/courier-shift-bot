/**
 * Tests for version helpers.
 */

const { test, assertEqual } = require('./run');
const { _bumpVersion, _getChangedFiles } = require('../services/version');

test('_bumpVersion increments patch by default', () => {
  assertEqual(_bumpVersion('2.4.10', 'patch'), '2.4.11');
});

test('_bumpVersion increments minor', () => {
  assertEqual(_bumpVersion('2.4.10', 'minor'), '2.5.0');
});

test('_bumpVersion increments major', () => {
  assertEqual(_bumpVersion('2.4.10', 'major'), '3.0.0');
});

test('_getChangedFiles detects added/removed/changed files', () => {
  const changed = _getChangedFiles({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' });
  assertEqual(changed.includes('b'), true);
  assertEqual(changed.includes('c'), true);
  assertEqual(changed.includes('a'), false);
});
