/**
 * Safe logging helpers with PII redaction.
 * Redacts phone numbers, emails, numeric Telegram IDs, tokens, card numbers,
 * and overly long numeric strings before writing to stdout/stderr.
 */

function redact(str) {
  if (str == null) return String(str);
  let s = String(str);

  // E-mail addresses
  s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');

  // Phone numbers (+7 / 8 / + any country) — conservative pattern
  s = s.replace(/(\+?\d[\s\-()]*){7,}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 16) return '[PHONE]';
    return match;
  });

  // Telegram bot tokens (digits:alphanumeric)
  s = s.replace(/\d{6,10}:[a-zA-Z0-9_-]{30,}/g, '[BOT_TOKEN]');

  // Credit card numbers (13-19 consecutive digits, optional spaces)
  s = s.replace(/(?:\d[ -]*?){13,19}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19) return '[CARD]';
    return match;
  });

  // Numeric Telegram IDs / chat IDs — standalone 7-15 digit numbers preceded/followed by id/chat/user context
  s = s.replace(/(id[:=]?\s*|chat_id[:=]?\s*|user_id[:=]?\s*|telegramId[:=]?\s*|from[:=]?\s*)(\d{7,15})/gi, '$1[ID]');

  // Any remaining 10-15 digit sequences (common for chat/user IDs)
  s = s.replace(/\b\d{10,15}\b/g, '[ID]');

  return s;
}

function safeLog(method, ...args) {
  const redacted = args.map(a => {
    if (typeof a === 'string') return redact(a);
    if (a instanceof Error) return redact(a.message || a.toString());
    try {
      return redact(JSON.stringify(a));
    } catch (_) {
      return '[unserializable]';
    }
  });
  console[method](...redacted);
}

module.exports = {
  redact,
  log: (...args) => safeLog('log', ...args),
  error: (...args) => safeLog('error', ...args),
  warn: (...args) => safeLog('warn', ...args),
};
