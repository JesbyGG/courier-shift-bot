/**
 * Тесты чистых помощников courierActions (без сети/БД).
 */

const { test, assertEqual, assertTrue } = require("./run");
const createCourierActions = require("../services/courierActions");

const actions = createCourierActions({ telegram: {}, hooks: {} });
const { parseMileageNumber, formatMoneyRu, nextStage } = actions._internal;

test("parseMileageNumber accepts 2..6 digits", () => {
  assertEqual(parseMileageNumber("25"), 25);
  assertEqual(parseMileageNumber("25408"), 25408);
  assertEqual(parseMileageNumber("123456"), 123456);
});

test("parseMileageNumber strips non-digits", () => {
  assertEqual(parseMileageNumber(" 25 408 км "), 25408);
});

test("parseMileageNumber rejects too short / too long / empty", () => {
  assertEqual(parseMileageNumber("7"), null);
  assertEqual(parseMileageNumber("1234567"), null);
  assertEqual(parseMileageNumber(""), null);
  assertEqual(parseMileageNumber("abc"), null);
});

test("formatMoneyRu formats with two decimals and currency", () => {
  assertTrue(formatMoneyRu(1000).includes("₽"));
  assertTrue(formatMoneyRu(1000).includes("1"));
  assertEqual(formatMoneyRu(-5), "0,00 ₽");
});

test("nextStage derives the next shift stage", () => {
  assertEqual(nextStage("none"), "start");
  assertEqual(nextStage("start"), "end");
  assertEqual(nextStage("end"), null);
  assertEqual(nextStage("both"), null);
});

test("createCourierActions requires telegram instance", () => {
  let threw = false;
  try {
    createCourierActions({});
  } catch (_) {
    threw = true;
  }
  assertTrue(threw, "expected error without telegram");
});
