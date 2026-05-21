const axios = require('axios');

const OCR_CONCURRENCY = 2;
let activeOcrRequests = 0;
const ocrQueue = [];

function enqueueOcrRequest(fn) {
  return new Promise((resolve, reject) => {
    ocrQueue.push({ fn, resolve, reject });
    processNextOcrRequest();
  });
}

function processNextOcrRequest() {
  if (activeOcrRequests >= OCR_CONCURRENCY || ocrQueue.length === 0) return;
  activeOcrRequests++;
  const { fn, resolve, reject } = ocrQueue.shift();
  Promise.resolve().then(() => fn()).then(
    (result) => {
      resolve(result);
      activeOcrRequests--;
      processNextOcrRequest();
    },
    (error) => {
      reject(error);
      activeOcrRequests--;
      processNextOcrRequest();
    }
  );
}

function isRapidOcrEnabled() {
  return process.env.RAPIDOCR_ENABLED !== 'false';
}

function getMinMileageThreshold() {
  const value = Number(process.env.OCR_MIN_MILEAGE || 1000);
  if (!Number.isFinite(value) || value < 0) return 1000;
  return value;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactText(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, '');
}

function isOdometerNoiseText(text) {
  const raw = normalizeText(text);
  const compact = compactText(text);
  if (!compact) return true;

  if (/\b\d{1,2}:\d{2}\b/.test(raw)) return true;
  if (/-?\d{1,2}\s*[°º]/.test(raw)) return true;

  const noiseTokens = [
    'km/h',
    'mph',
    'rpm',
    'x1000',
    '/100',
    'l/100',
    '1/100',
    'trip',
    'avg',
    'temp'
  ];

  return noiseTokens.some((token) => compact.includes(token));
}

function extractMileage(text, options = {}) {
  const minDigits = Number.isFinite(options.minDigits) ? options.minDigits : 2;
  const maxDigits = Number.isFinite(options.maxDigits) ? options.maxDigits : 6;
  if (options.skipNoise !== false && isOdometerNoiseText(text)) {
    return null;
  }

  const normalized = String(text || '').replace(/[Oo]/g, '0');
  const candidates = new Set();
  const strictRegex = new RegExp(`\\d{${minDigits},${maxDigits}}`, 'g');
  const flexibleRegex = new RegExp(`(?:\\d[\\s.,:;\\-]*){${minDigits},${maxDigits}}`, 'g');

  for (const match of normalized.matchAll(strictRegex)) {
    candidates.add(match[0]);
  }

  for (const match of normalized.matchAll(flexibleRegex)) {
    const value = match[0].replace(/\D/g, '');

    if (value.length >= minDigits && value.length <= maxDigits) {
      candidates.add(value);
    }
  }

  const values = Array.from(candidates);

  if (values.length === 0) {
    return null;
  }

  values.sort((a, b) => b.length - a.length || Number(b) - Number(a));
  return Number(values[0]);
}

function isMileageInBounds(mileage, options = {}) {
  if (!Number.isFinite(mileage)) return false;

  const minMileage = Number.isFinite(options.minMileage)
    ? options.minMileage
    : getMinMileageThreshold();
  const maxMileage = Number.isFinite(options.maxMileage)
    ? options.maxMileage
    : null;

  if (Number.isFinite(minMileage) && mileage < minMileage) return false;
  if (Number.isFinite(maxMileage) && mileage > maxMileage) return false;
  return true;
}

function smartPickFromGroups(groups, options = {}) {
  if (!groups || groups.length === 0) return { mileage: null, candidates: [] };

  const valid = groups.filter((g) => Number.isFinite(g.mileage) && g.mileage > 0);
  if (valid.length === 0) return { mileage: null, candidates: [] };

  const ranked = [...valid].sort((a, b) => {
    if (a.has_km !== b.has_km) return (b.has_km ? 1 : 0) - (a.has_km ? 1 : 0);

    const aLen = String(a.mileage).length;
    const bLen = String(b.mileage).length;
    const aOdo = aLen >= 4 && aLen <= 7 ? 1 : 0;
    const bOdo = bLen >= 4 && bLen <= 7 ? 1 : 0;
    if (aOdo !== bOdo) return bOdo - aOdo;

    const aNoise = a.is_noise ? 0 : 1;
    const bNoise = b.is_noise ? 0 : 1;
    if (aNoise !== bNoise) return bNoise - aNoise;

    const aInBounds = isMileageInBounds(a.mileage, options) ? 1 : 0;
    const bInBounds = isMileageInBounds(b.mileage, options) ? 1 : 0;
    if (aInBounds !== bInBounds) return bInBounds - aInBounds;

    if (a.count !== b.count) return b.count - a.count;
    return b.avgConfidence - a.avgConfidence;
  });

  const best = ranked[0];
  if (best && best.avgConfidence >= 0.30) {
    return { mileage: best.mileage, candidates: ranked.slice(0, 5).map((g) => ({ mileage: g.mileage, source: 'ocr', confidence: g.avgConfidence })) };
  }

  if (best && best.count >= 1 && isMileageInBounds(best.mileage, options)) {
    return { mileage: best.mileage, candidates: ranked.slice(0, 5).map((g) => ({ mileage: g.mileage, source: 'ocr', confidence: g.avgConfidence })) };
  }

  return { mileage: null, candidates: ranked.slice(0, 5).map((g) => ({ mileage: g.mileage, source: 'ocr', confidence: g.avgConfidence })) };
}

// AI vision logic completely removed

async function recognizeMileageWithRapidOcr(imageBuffer, options = {}) {
  const rapidOcrUrl = process.env.RAPIDOCR_URL || '';

  if (!rapidOcrUrl) {
    console.error('RapidOCR: RAPIDOCR_URL not configured');
    return { engine: 'rapidocr', mileage: null, groups: [], best: null, raw: null, reason: 'no_url' };
  }

  try {
    const response = await enqueueOcrRequest(() => axios.post(rapidOcrUrl, imageBuffer, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/octet-stream' }
    }));
    const parsed = response.data;
    console.log('RapidOCR HTTP result', JSON.stringify(parsed).substring(0, 500));
    return mapRapidOcrResult(parsed, options);
  } catch (error) {
    console.error('RapidOCR HTTP error:', error.message);
    return { engine: 'rapidocr', mileage: null, groups: [], best: null, raw: null, reason: 'error' };
  }
}

function mapRapidOcrResult(parsed, options) {
  const groups = Array.isArray(parsed.groups)
    ? parsed.groups
        .map((group) => ({
          mileage: Number(group.mileage),
          count: Number(group.count || 0),
          avgConfidence: Number(group.avg_confidence || 0),
          maxConfidence: Number(group.max_confidence || 0),
          has_km: !!group.has_km,
          is_noise: !!group.is_noise
        }))
        .filter((group) => Number.isFinite(group.mileage) && group.mileage > 0)
    : [];

  const best = groups[0] || null;
  const pick = smartPickFromGroups(groups, options);

  return {
    engine: 'rapidocr',
    mileage: pick.mileage,
    groups,
    best,
    candidates: pick.candidates,
    raw: parsed,
    reason: pick.mileage ? 'accepted' : (best ? 'weak_confidence' : 'no_candidate')
  };
}

async function downloadTelegramFile(ctx, fileId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const response = await axios.get(link.href, { responseType: 'arraybuffer', timeout: 30000 });
      return Buffer.from(response.data);
    } catch (error) {
      console.error(`Download attempt ${attempt}/${retries} failed`, error.message);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } else {
        throw error;
      }
    }
  }
}

function isValidImageBuffer(buffer) {
  if (!buffer || buffer.length < 100) return false;
  const b = buffer[0];
  const b1 = buffer[1];
  if (b === 0xFF && b1 === 0xD8) return true;
  if (b === 0x89 && b1 === 0x50) return true;
  if (b === 0x47 && b1 === 0x49) return true;
  if (b === 0x52 && b1 === 0x49) return true;
  if (b === 0x42 && b1 === 0x4D) return true;
  return false;
}

async function recognizeMileage(ctx, fileId, options = {}) {
  const startTime = Date.now();
  const onStatus = options.onStatus || null;

  let sourceBuffer = options.sourceBuffer || null;
  if (!sourceBuffer) {
    try {
      sourceBuffer = await downloadTelegramFile(ctx, fileId);
      console.log('OCR timing: download', Date.now() - startTime, 'ms');
    } catch (error) {
      console.error('OCR download error', error.message);
      return null;
    }
  }

  if (!isValidImageBuffer(sourceBuffer)) {
    console.error('OCR: downloaded file is not a valid image', { size: sourceBuffer?.length, firstBytes: sourceBuffer?.slice(0, 4).toString('hex') });
    return null;
  }

  try {
    const ocrStartTime = Date.now();
    const rapidResult = await recognizeMileageWithRapidOcr(sourceBuffer, options);
    console.log('OCR timing: RapidOCR', Date.now() - ocrStartTime, 'ms');

    const ocrMileage = rapidResult.mileage;
    const groups = rapidResult.groups || [];
    const ocrCandidates = rapidResult.candidates || [];

    if (ocrMileage) {
      console.log('OCR accepted', {
        mileage: ocrMileage,
        source: rapidResult.reason,
        groups: groups.map((g) => `${g.mileage}(×${g.count} avg=${g.avgConfidence.toFixed(2)} max=${g.maxConfidence.toFixed(2)})`).join(', '),
        minMileage: options.minMileage,
        maxMileage: options.maxMileage
      });
      console.log('OCR timing: total', Date.now() - startTime, 'ms');
      return { mileage: ocrMileage, candidates: ocrCandidates };
    }

    console.log('OCR rejected', {
      reason: rapidResult.reason,
      groups: groups.map((g) => `${g.mileage}(×${g.count} avg=${g.avgConfidence.toFixed(2)})`).join(', '),
      best: rapidResult.best ? `${rapidResult.best.mileage}(×${rapidResult.best.count})` : null
    });
    console.log('OCR timing: total', Date.now() - startTime, 'ms');
    return { mileage: null, candidates: ocrCandidates };
  } catch (error) {
    console.error('OCR error', error.message || error);
    return null;
  }
}

async function recognizeTextWithRapidOcr(imageBuffer) {
  const rapidOcrUrl = process.env.RAPIDOCR_URL || '';

  if (!rapidOcrUrl) {
    return null;
  }

  try {
    const url = rapidOcrUrl.replace(/\/+$/, '') + '/text';
    const response = await enqueueOcrRequest(() => axios.post(url, imageBuffer, {
      timeout: 120000,
      headers: { 'Content-Type': 'application/octet-stream' }
    }));
    const items = response.data?.text_items;
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const combined = items.map((item) => item.text || '').join('\n');
    console.log('RapidOCR text recognition', items.length, 'items, text:', combined.substring(0, 500));
    return combined;
  } catch (error) {
    console.error('RapidOCR text recognition error:', error.message);
    return null;
  }
}

async function checkRapidOcrHealth() {
  const rapidOcrUrl = process.env.RAPIDOCR_URL || '';
  if (!rapidOcrUrl) return false;

  try {
    const response = await axios.get(`${rapidOcrUrl.replace(/\/+$/, '')}/health`, { timeout: 5000 });
    return response.status === 200 && response.data?.status === 'ok';
  } catch (error) {
    console.error('RapidOCR health check failed:', error.message);
    return false;
  }
}

module.exports = {
  recognizeMileage,
  downloadTelegramFile,
  recognizeTextWithRapidOcr,
  isRapidOcrEnabled,
  getMinMileageThreshold,
  checkRapidOcrHealth
};