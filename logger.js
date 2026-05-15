const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'bot.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024;

const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);

function _format(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return `${ts} [${level}] ${msg}\n`;
}

function _write(line) {
  try {
    fs.appendFileSync(logPath, line, 'utf8');
    const stat = fs.statSync(logPath);
    if (stat.size > MAX_LOG_SIZE) {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n');
      const keep = lines.slice(Math.floor(lines.length / 2)).join('\n');
      fs.writeFileSync(logPath, keep, 'utf8');
    }
  } catch (_) {}
}

function initLogger() {
  console.log = function (...args) {
    _origLog(...args);
    _write(_format('INFO', ...args));
  };
  console.error = function (...args) {
    _origError(...args);
    _write(_format('ERROR', ...args));
  };
}

module.exports = { initLogger };
