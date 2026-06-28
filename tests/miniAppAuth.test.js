/**
 * Тесты валидации Telegram Mini App initData.
 */

const crypto = require("crypto");
const { test, assertEqual, assertTrue, assertFalse } = require("./run");
const { validateInitData } = require("../api/auth");

const TOKEN = "123456:TEST-TOKEN";

function signInitData(token, { authDate, user } = {}) {
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate || Math.floor(Date.now() / 1000)));
  params.set("user", JSON.stringify(user || { id: 777, first_name: "Тест" }));
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

test("validateInitData accepts a correctly signed payload", () => {
  const initData = signInitData(TOKEN);
  const res = validateInitData(initData, TOKEN);
  assertTrue(res.ok, "expected ok");
  assertEqual(res.telegramId, 777, "telegramId mismatch");
});

test("validateInitData rejects a tampered hash", () => {
  const initData = signInitData(TOKEN).replace(/hash=[0-9a-f]+/, "hash=deadbeef");
  const res = validateInitData(initData, TOKEN);
  assertFalse(res.ok, "tampered payload must be rejected");
  assertEqual(res.error, "bad_hash");
});

test("validateInitData rejects a wrong bot token", () => {
  const initData = signInitData(TOKEN);
  const res = validateInitData(initData, "999:OTHER");
  assertFalse(res.ok, "wrong token must be rejected");
});

test("validateInitData rejects an expired auth_date", () => {
  const old = Math.floor(Date.now() / 1000) - 60 * 60 * 48; // 48h ago
  const initData = signInitData(TOKEN, { authDate: old });
  const res = validateInitData(initData, TOKEN, { maxAgeSeconds: 86400 });
  assertFalse(res.ok, "expired payload must be rejected");
  assertEqual(res.error, "expired");
});

test("validateInitData rejects empty input", () => {
  assertFalse(validateInitData("", TOKEN).ok);
  assertFalse(validateInitData(null, TOKEN).ok);
});

test("validateInitData rejects payload without user", () => {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  const res = validateInitData(params.toString(), TOKEN);
  assertFalse(res.ok, "payload without user must be rejected");
  assertEqual(res.error, "no_user");
});
