/**
 * Version management: source snapshot, git log parsing, changelog bumps,
 * version.json persistence.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const safeLog = require('../utils/safeLog');

const versionPath = path.join(__dirname, '..', 'version.json');
const changelogPath = path.join(__dirname, '..', 'changelog.json');
const _sourceDir = path.join(__dirname, '..');

const _EN_TO_RU = {
  'gemini': 'Gemini', 'prompt': 'промт', 'remove': 'удалён', 'switch': 'замена',
  'fix': 'исправление', 'add': 'добавлено', 'better': 'улучшен', 'single': 'только число',
  'odometer': 'одометр', 'mileage': 'пробег', 'ocr': 'OCR', 'text': 'текст',
  'fallback': 'запасной вариант', 'model': 'модель', 'available': 'доступна',
  'deprecated': 'устарела', 'numpy': 'numpy', 'import': 'импорт',
  'config': 'настройки', 'ecosystem': 'конфиг', 'server': 'сервер',
  'reader': 'чтение', 'env': 'окружение', 'key': 'ключ', 'api': 'API',
  'flash': 'Flash', 'lite': 'Lite', 'photo': 'фото', 'image': 'изображение',
  'dashboard': 'панель приборов', 'car': 'автомобиля', 'number': 'номер',
  'ignore': 'игнорируется', 'time': 'время', 'temperature': 'температура',
  'fuel': 'топливо', 'speed': 'скорость', 'rpm': 'RPM', 'trip': 'поездка',
  'reply': 'ответ', 'only': 'только', 'analyze': 'анализ', 'find': 'поиск',
  'total': 'общий',
  'initialize': 'загрузка',
  'support': 'поддержка', 'configured': 'настроен', 'version': 'версия',
  'startup': 'запуск', 'health': 'проверка', 'endpoint': 'эндпоинт',
  'sheet': 'таблица', 'log': 'лог', 'change': 'изменение', 'update': 'обновление',
  'clean': 'очистка', 'old': 'старый', 'new': 'новый', 'code': 'код',
  'file': 'файл', 'function': 'функция', 'variable': 'переменная',
  'error': 'ошибка', 'handle': 'обработка', 'result': 'результат',
  'recognize': 'распознавание', 'recognize_text': 'распознавание текста',
  'extract': 'извлечение', 'detect': 'обнаружение', 'check': 'проверка',
  'validate': 'валидация', 'save': 'сохранение', 'load': 'загрузка',
  'process': 'обработка', 'background': 'фоновая', 'async': 'асинхронно',
};

const COMMIT_PREFIX_RU = {
  feat: '✨ Добавлено',
  fix: '🔧 Исправлено',
  refactor: '♻️ Переработано',
  chore: '🔧 Техническое',
  docs: '📝 Документация',
  style: '🎨 Оформление',
  perf: '⚡ Оптимизация',
  test: '🧪 Тесты',
  build: '📦 Сборка',
  ci: '⚙️ CI/CD',
  revert: '↩️ Откат'
};

function _getCurrentVersion() {
  try {
    if (!fs.existsSync(versionPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  } catch {
    return null;
  }
}

function _getSourceFiles() {
  const dirs = [
    _sourceDir,
    path.join(_sourceDir, 'services'),
    path.join(_sourceDir, 'handlers'),
    path.join(_sourceDir, 'menus')
  ];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const dirFiles = fs.readdirSync(dir)
      .filter(f => f.endsWith('.js') && f !== 'version.js')
      .map(f => path.relative(_sourceDir, path.join(dir, f)));
    files.push(...dirFiles);
  }
  return files.sort();
}

function _computeSourceSnapshot() {
  const jsFiles = _getSourceFiles();
  const fileHashes = {};
  const combinedHash = crypto.createHash('sha256');
  for (const file of jsFiles) {
    const filePath = path.join(_sourceDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const fileHash = crypto.createHash('sha256').update(content).digest('hex');
      fileHashes[file] = fileHash;
      combinedHash.update(file);
      combinedHash.update(fileHash);
    } catch {
    }
  }
  return {
    hash: combinedHash.digest('hex'),
    files: fileHashes
  };
}

function _getChangedFiles(previousFiles, currentFiles) {
  const prev = previousFiles || {};
  const next = currentFiles || {};
  const allFiles = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...allFiles]
    .filter((file) => prev[file] !== next[file])
    .sort();
}

function _getCurrentGitHash() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: _sourceDir }).trim();
  } catch {
    return null;
  }
}

function _translateToRussian(text) {
  let result = text;
  for (const [en, ru] of Object.entries(_EN_TO_RU)) {
    const regex = new RegExp(`\\b${en}\\b`, 'gi');
    result = result.replace(regex, ru);
  }
  result = result.replace(/\b(\d+)\s*-\s*(\w)/g, (m, d, w) => `${d} — ${w.toLowerCase()}`);
  return result;
}

function _getGitLogSince(fromHash) {
  if (!fromHash) return null;
  if (!/^[0-9a-f]{4,40}$/i.test(fromHash)) return null;
  try {
    const log = execSync(`git log --oneline --no-merges ${fromHash}..HEAD`, { encoding: 'utf8', cwd: _sourceDir });
    return log.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        let msg = line.replace(/^[0-9a-f]+\s+/, '');
        const prefixMatch = msg.match(/^(feat|fix|refactor|chore|docs|style|perf|test|build|ci|revert):\s*/i);
        if (prefixMatch) {
          const prefix = prefixMatch[1].toLowerCase();
          const ruPrefix = COMMIT_PREFIX_RU[prefix] || prefix;
          msg = msg.slice(prefixMatch[0].length);
          msg = _translateToRussian(msg);
          msg = msg.charAt(0).toUpperCase() + msg.slice(1);
          return `${ruPrefix}: ${msg}`;
        }
        if (msg.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u)) {
          return msg.charAt(0).toUpperCase() + msg.slice(1);
        }
        msg = _translateToRussian(msg);
        msg = msg.charAt(0).toUpperCase() + msg.slice(1);
        return msg;
      })
      .filter(msg => msg.length > 0);
  } catch {
    return null;
  }
}

function _bumpVersion(version, bumpType) {
  const parts = version.split('.').map(Number);
  if (bumpType === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (bumpType === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    parts[2] = (parts[2] || 0) + 1;
  }
  return parts.join('.');
}

function loadChangelog() {
  try {
    if (!fs.existsSync(changelogPath)) return null;
    return JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
  } catch {
    return null;
  }
}

function getLatestChangelogNotes() {
  const changelog = loadChangelog();
  if (!changelog || !Array.isArray(changelog.updates) || changelog.updates.length === 0) return null;

  const latest = changelog.updates[changelog.updates.length - 1];
  if (!latest || !Array.isArray(latest.notes) || latest.notes.length === 0) return null;

  return latest.notes.slice(0, 4);
}

function getChangelogBump() {
  const changelog = loadChangelog();
  if (!changelog || !Array.isArray(changelog.updates) || changelog.updates.length === 0) return 'patch';

  const latest = changelog.updates[changelog.updates.length - 1];
  const bump = String(latest.bump || '').toLowerCase().trim();
  if (bump === 'major' || bump === 'minor') return bump;
  return 'patch';
}

function checkVersion() {
  const snapshot = _computeSourceSnapshot();
  const currentHash = snapshot.hash;
  const currentFiles = snapshot.files;
  const stored = _getCurrentVersion();
  if (!stored) {
    const initialVersion = '2.0.0';
    const gitHash = _getCurrentGitHash();
    const data = {
      version: initialVersion,
      lastHash: currentHash,
      files: currentFiles,
      updatedAt: new Date().toISOString(),
      gitHash: gitHash || undefined,
      updates: []
    };
    fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf8');
    return {
      version: initialVersion,
      changed: true,
      prevVersion: null,
      changedFiles: Object.keys(currentFiles).sort(),
      updates: []
    };
  }
  if (stored.lastHash === currentHash) {
    return { version: stored.version, changed: false, prevVersion: null, changedFiles: [], updates: stored.updates || [] };
  }
  const changedFiles = _getChangedFiles(stored.files, currentFiles);
  const bumpType = getChangelogBump();
  const newVersion = _bumpVersion(stored.version, bumpType);
  let updates = _getGitLogSince(stored.gitHash);
  if (!updates || updates.length === 0) {
    updates = null;
  }
  const gitHash = _getCurrentGitHash();
  const data = {
    version: newVersion,
    lastHash: currentHash,
    files: currentFiles,
    updatedAt: new Date().toISOString(),
    gitHash: gitHash || undefined,
    updates: updates || []
  };
  fs.writeFileSync(versionPath, JSON.stringify(data, null, 2), 'utf8');
  safeLog.log(`version bumped: ${stored.version} → ${newVersion} (${bumpType})`);
  return { version: newVersion, changed: true, prevVersion: stored.version, changedFiles, updates: updates || [] };
}

function getVersion() {
  const stored = _getCurrentVersion();
  return stored ? stored.version : '2.0.0';
}

module.exports = {
  versionPath,
  changelogPath,
  _getCurrentVersion,
  _getSourceFiles,
  _computeSourceSnapshot,
  _getChangedFiles,
  _getCurrentGitHash,
  _translateToRussian,
  _getGitLogSince,
  _bumpVersion,
  loadChangelog,
  getLatestChangelogNotes,
  getChangelogBump,
  checkVersion,
  getVersion
};
