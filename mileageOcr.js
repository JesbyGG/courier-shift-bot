const axios = require('axios');
const sharp = require('sharp');

function isRapidOcrEnabled() {
  return process.env.RAPIDOCR_ENABLED !== 'false';
}

function getMinMileageThreshold() {
  const value = Number(process.env.OCR_MIN_MILEAGE || 1000);
  if (!Number.isFinite(value) || value < 0) return 1000;
  return value;
}

function isAiVisionEnabled() {
  return process.env.AI_VISION_ENABLED === 'true' && !!process.env.OPENROUTER_API_KEY;
}

function getAiVisionModels() {
  const models = process.env.AI_VISION_MODELS || '';
  if (models) return models.split(',').map((m) => m.trim()).filter(Boolean);
  return [
    'google/gemma-3-27b-it:free',
    'google/gemma-4-31b-it:free',
  ];
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

function isPrefixOf(other, shorter) {
  const s = String(shorter);
  const o = String(other);
  return o.startsWith(s) && o.length === s.length + 1;
}

function smartPickFromGroups(groups, options = {}) {
  if (!groups || groups.length === 0) return { mileage: null, candidates: [] };

  const valid = groups.filter((g) => Number.isFinite(g.mileage) && g.mileage > 0);
  if (valid.length === 0) return { mileage: null, candidates: [] };

  const inBounds = valid.filter((g) => isMileageInBounds(g.mileage, options));
  const pool = inBounds.length > 0 ? inBounds : valid;

  const allCandidates = [];

  if (pool.length === 1) {
    const g = pool[0];
    if (g.count < 1 || g.avgConfidence < 0.40) {
      return { mileage: null, candidates: pool };
    }
    return { mileage: g.mileage, candidates: pool };
  }

  const bylen = [...pool].sort((a, b) => {
    const lenDiff = String(b.mileage).length - String(a.mileage).length;
    if (Math.abs(lenDiff) >= 1) return lenDiff;
    return b.count - a.count || b.avgConfidence - a.avgConfidence;
  });

  for (let i = 0; i < bylen.length; i++) {
    const candidate = bylen[i];
    const candidateStr = String(candidate.mileage);

    for (let j = i + 1; j < bylen.length; j++) {
      const other = bylen[j];
      const otherStr = String(other.mileage);

      if (isPrefixOf(otherStr, candidateStr) || isPrefixOf(candidateStr, otherStr)) {
        const longer = candidateStr.length > otherStr.length ? candidate : other;
        const shorter = candidateStr.length > otherStr.length ? other : candidate;
        const longerStr = String(longer.mileage);
        const shorterStr = String(shorter.mileage);

        if (longerStr.endsWith('0') && shorterStr === longerStr.slice(0, -1)) {
          const lcdAlt = longer.mileage + 1;
          if (isMileageInBounds(lcdAlt, options)) {
            allCandidates.push({ mileage: lcdAlt, source: 'lcd', confidence: longer.avgConfidence * 0.85 });
            allCandidates.push({ mileage: longer.mileage, source: 'ocr', confidence: longer.avgConfidence });
            allCandidates.push({ mileage: shorter.mileage, source: 'ocr', confidence: shorter.avgConfidence });
            if (longer.avgConfidence >= 0.50) {
              return { mileage: lcdAlt, candidates: allCandidates };
            }
          }
        }

        if (longer.avgConfidence >= 0.50 && (longer.count >= 1 || shorter.count >= 2)) {
          allCandidates.push({ mileage: longer.mileage, source: 'ocr', confidence: longer.avgConfidence });
          return { mileage: longer.mileage, candidates: allCandidates };
        }
      }
    }
  }

  const best = bylen[0];
  if (best.count >= 1 && best.avgConfidence >= 0.40) {
    return { mileage: best.mileage, candidates: [{ mileage: best.mileage, source: 'ocr', confidence: best.avgConfidence }] };
  }

  return { mileage: null, candidates: pool };
}

async function resizeForAI(imageBuffer) {
  try {
    const resized = await sharp(imageBuffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    console.log(`AI vision filter: resized image ${imageBuffer.length} → ${resized.length} bytes`);
    return resized;
  } catch (error) {
    console.error('AI vision filter: resize failed, using original', error.message);
    return imageBuffer;
  }
}

async function filterCandidatesWithAI(imageBuffer, candidates, options = {}) {
  if (!isAiVisionEnabled()) {
    console.log('AI vision filter: disabled');
    return null;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const models = getAiVisionModels();
  if (!apiKey || models.length === 0 || !candidates || candidates.length === 0) {
    return null;
  }

  const candidateList = candidates
    .slice(0, 10)
    .map((c) => String(c.mileage || c))
    .join(', ');

  const stageLabel = options.stage === 'start' ? 'начало смены' : options.stage === 'end' ? 'конец смены' : 'неизвестный этап';
  const boundsInfo = [];
  if (Number.isFinite(options.minMileage)) boundsInfo.push(`минимум ${options.minMileage}`);
  if (Number.isFinite(options.maxMileage)) boundsInfo.push(`максимум ${options.maxMileage}`);
  const boundsStr = boundsInfo.length > 0 ? ` Ограничения: ${boundsInfo.join(', ')}.` : '';

  const prompt = `Это фото приборной панели автомобиля. На нём виден одометр (счётчик пробега).
OCR-система нашла следующие кандидаты пробега: ${candidateList}.
Контекст: ${stageLabel}.${boundsStr}

Какой из этих кандидатов скорее всего правильный пробег на одометре? Ответь ТОЛЬКО числом, без пояснений. Если ни один не подходит, ответь 0.`;

  const resizedBuffer = await resizeForAI(imageBuffer);
  const base64Image = resizedBuffer.toString('base64');
  const imageDataUrl = `data:image/jpeg;base64,${base64Image}`;

  for (const model of models) {
    try {
      console.log(`AI vision filter: trying model ${model}`);
      const startTime = Date.now();

      const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageDataUrl } },
              { type: 'text', text: prompt }
            ]
          }
        ],
        max_tokens: 20,
        temperature: 0.1
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/courier-shift-bot',
          'X-Title': 'Courier Shift Bot - Mileage OCR'
        },
        timeout: 30000
      });

      const elapsed = Date.now() - startTime;
      const message = response.data?.choices?.[0]?.message;
      const content = message?.content?.trim() || '';
      const reasoning = message?.reasoning || '';
      const fullText = content || (typeof reasoning === 'string' ? reasoning : '');
      const parsed = parseInt(fullText.replace(/\D/g, ''), 10);
      console.log(`AI vision filter: model=${model} content="${content?.substring(0, 80)}" reasoning="${typeof reasoning === 'string' ? reasoning.substring(0, 80) : ''}" parsed=${parsed} elapsed=${elapsed}ms`);

      if (!content && !reasoning) {
        console.log(`AI vision filter: model ${model} returned empty response, skipping`);
        continue;
      }

      if (fullText.toLowerCase().includes('does not support image') ||
          fullText.toLowerCase().includes('cannot read') ||
          fullText.toLowerCase().includes('image input') ||
          fullText.toLowerCase().includes('i cannot') ||
          fullText.toLowerCase().includes('unable to process')) {
        console.log(`AI vision filter: model ${model} cannot process images, skipping`);
        continue;
      }

      if (Number.isFinite(parsed) && parsed > 0) {
        const match = candidates.find((c) => c.mileage === parsed || c === parsed);
        if (match) {
          console.log(`AI vision filter: confirmed candidate ${parsed} from model ${model}`);
          return { mileage: parsed, model, elapsed };
        }

        // Раньше тут был aiOnly fallback: если AI вернул число в ±5% от
        // диапазона кандидатов, мы принимали его как правду. Это позволяло
        // галлюцинациям модели попадать в таблицу. Теперь требуем СТРОГОЕ
        // совпадение — AI работает только как фильтр среди известных
        // OCR-кандидатов, а не как источник истины.
        console.log(`AI vision filter: model ${model} returned ${parsed}, not in candidates — ignoring`);
      }
    } catch (error) {
      const status = error.response?.status;
      const msg = error.message || 'unknown';
      console.error(`AI vision filter: model ${model} failed: ${status} ${msg}`);
      if (status === 429) {
        console.log('AI vision filter: rate limited, waiting 2s');
        await new Promise((r) => setTimeout(r, 2000));
      }
      continue;
    }
  }

  console.log('AI vision filter: all models failed or returned no match');
  return null;
}

async function recognizeMileageWithRapidOcr(imageBuffer, options = {}) {
  const rapidOcrUrl = process.env.RAPIDOCR_URL || '';

  if (!rapidOcrUrl) {
    console.error('RapidOCR: RAPIDOCR_URL not configured');
    return { engine: 'rapidocr', mileage: null, groups: [], best: null, raw: null, reason: 'no_url' };
  }

  try {
    const response = await axios.post(rapidOcrUrl, imageBuffer, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
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
          maxConfidence: Number(group.max_confidence || 0)
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

function isOcrUncertain(groups, ocrMileage) {
  if (!groups || groups.length === 0) return true;
  const valid = groups.filter((g) => g.count >= 1 && g.avgConfidence >= 0.40);
  if (valid.length === 0) return true;
  
  // Always use AI if there are multiple competing valid candidates
  if (valid.length > 1) return true;
  
  const best = valid[0];
  
  // If we only have 1 hit, or confidence is not extremely high, use AI
  if (best.count < 3 || best.avgConfidence < 0.90) return true;
  
  // If it's a 6-digit number starting with 1 or 0, it might be a glare or trip meter. Use AI.
  const strMileage = String(best.mileage);
  if (strMileage.length >= 6 && (strMileage.startsWith('1') || strMileage.startsWith('0'))) {
    return true;
  }
  
  return false;
}

async function recognizeMileage(ctx, fileId, options = {}) {
  const startTime = Date.now();
  const onStatus = options.onStatus || null;

  let sourceBuffer;
  try {
    sourceBuffer = await downloadTelegramFile(ctx, fileId);
    console.log('OCR timing: download', Date.now() - startTime, 'ms');
  } catch (error) {
    console.error('OCR download error', error.message);
    return null;
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
    const candidates = rapidResult.candidates || [];

    if (isAiVisionEnabled() && groups.length > 0) {
      const needsAi = isOcrUncertain(groups, ocrMileage);
      if (needsAi) {
        if (onStatus) {
          const candidateStr = groups.slice(0, 5).map((g) => `${g.mileage} (×${g.count})`).join(', ');
          await onStatus(`🤖 RapidOCR нашёл несколько вариантов:\n${candidateStr}\n\nУточняю у ИИ...`);
        }
        const aiCandidates = candidates.length > 0 ? candidates : groups;
        const aiResult = await filterCandidatesWithAI(sourceBuffer, aiCandidates, options);
        if (aiResult && Number.isFinite(aiResult.mileage) && aiResult.mileage > 0) {
          console.log('OCR accepted (AI confirmed)', {
            ocrMileage,
            aiMileage: aiResult.mileage,
            aiModel: aiResult.model,
            aiOnly: aiResult.aiOnly || false,
            groups: groups.map((g) => `${g.mileage}(×${g.count} avg=${g.avgConfidence.toFixed(2)})`).join(', ')
          });
          console.log('OCR timing: total', Date.now() - startTime, 'ms');
          return aiResult.mileage;
        } else {
          console.log('OCR rejected (AI could not confirm any candidate)', { ocrMileage });
          console.log('OCR timing: total', Date.now() - startTime, 'ms');
          return null;
        }
      } else {
        console.log('OCR confident, skipping AI filter', {
          mileage: ocrMileage,
          bestCount: groups[0]?.count,
          bestConf: groups[0]?.avgConfidence?.toFixed(2),
          groupsCount: groups.length
        });
      }
    }

    if (ocrMileage) {
      console.log('OCR accepted', {
        mileage: ocrMileage,
        source: rapidResult.reason,
        groups: groups.map((g) => `${g.mileage}(×${g.count} avg=${g.avgConfidence.toFixed(2)} max=${g.maxConfidence.toFixed(2)})`).join(', '),
        minMileage: options.minMileage,
        maxMileage: options.maxMileage
      });
      console.log('OCR timing: total', Date.now() - startTime, 'ms');
      return ocrMileage;
    }

    console.log('OCR rejected', {
      reason: rapidResult.reason,
      groups: groups.map((g) => `${g.mileage}(×${g.count} avg=${g.avgConfidence.toFixed(2)})`).join(', '),
      best: rapidResult.best ? `${rapidResult.best.mileage}(×${rapidResult.best.count})` : null
    });
    console.log('OCR timing: total', Date.now() - startTime, 'ms');
    return null;
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
    const response = await axios.post(url, imageBuffer, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
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

module.exports = {
  recognizeMileage,
  recognizeTextWithRapidOcr,
  isRapidOcrEnabled
};