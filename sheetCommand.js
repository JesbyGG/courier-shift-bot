const { verifySheetAccess } = require('./services/googleSheets');
const {
  resolveSheetInfo,
  setWorkplaceSheetId,
  setWorkplaceSheetIdByMonth,
  getWorkplaceSheetIdByMonth,
  getWorkplaceMonthMap,
  getCurrentMonthKey,
  getNextMonthKey,
  isValidMonthKey
} = require('./services/storage');

function extractSheetId(text) {
  const value = String(text || '').trim();

  const match = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  const urlMatch = value.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];

  if (/^[a-zA-Z0-9_-]{20,}$/.test(value)) return value;
  return null;
}

function getWorkplaceFromToken(token) {
  const value = String(token || '').trim().toLowerCase();
  if (value === 'east' || value === 'восток') return 'ИМ Восток';
  if (value === 'center' || value === 'центр') return 'ИМ Центр';
  return null;
}

function parseSheetSlotToken(token) {
  const value = String(token || '').trim().toLowerCase();
  if (!value) return null;

  if (value === 'active' || value === 'актив' || value === 'current' || value === 'текущий' || value === 'этот') {
    const monthKey = getCurrentMonthKey();
    return { monthKey, slot: 'active', label: 'активный месяц' };
  }

  if (value === 'next' || value === 'следующий' || value === 'след') {
    const monthKey = getNextMonthKey();
    return { monthKey, slot: 'next', label: 'следующий месяц' };
  }

  if (isValidMonthKey(value)) {
    return { monthKey: value, slot: 'custom', label: `месяц ${value}` };
  }

  return null;
}

function extractMonthKeyFromTitle(title) {
  const text = String(title || '').toLowerCase().replace(/ё/g, 'е');

  let match = text.match(/\b(20\d{2})[._\-/\s](0?[1-9]|1[0-2])\b/);
  if (match) {
    return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;
  }

  match = text.match(/\b(0?[1-9]|1[0-2])[._\-/\s](20\d{2})\b/);
  if (match) {
    return `${match[2]}-${String(Number(match[1])).padStart(2, '0')}`;
  }

  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (!yearMatch) return null;
  const year = yearMatch[1];

  const monthPatterns = [
    { month: '01', patterns: [/январ/] },
    { month: '02', patterns: [/феврал/] },
    { month: '03', patterns: [/\bмарт\b|\bмар\b/] },
    { month: '04', patterns: [/апрел/] },
    { month: '05', patterns: [/\bмай\b|\bмая\b/] },
    { month: '06', patterns: [/июн/] },
    { month: '07', patterns: [/июл/] },
    { month: '08', patterns: [/август/] },
    { month: '09', patterns: [/сентябр/] },
    { month: '10', patterns: [/октябр/] },
    { month: '11', patterns: [/ноябр/] },
    { month: '12', patterns: [/декабр/] }
  ];

  for (const item of monthPatterns) {
    if (item.patterns.some((pattern) => pattern.test(text))) {
      return `${year}-${item.month}`;
    }
  }

  return null;
}

function registerSheetCommand(bot, options = {}) {
  const esc = options.esc || ((value) => String(value || ''));
  // По умолчанию берём WORKPLACES из config.js. options.workplaces оставлено
  // для обратной совместимости (можно переопределить из bot.js).
  const { WORKPLACES: defaultWorkplaces } = require('./config');
  const workplaces = options.workplaces || defaultWorkplaces;
  const isAdminUser = options.isAdminUser || ((id) => false);

  bot.command('sheet', async (ctx) => {
    // Защита от вызова из канала / неподдерживаемых апдейтов:
    // в канал-постах ctx.from может быть undefined, а ctx.message — null.
    if (!ctx.from || !ctx.from.id) return;
    if (!ctx.message) return;

    const adminIds = (process.env.ADMIN_IDS || '').split(',').map((id) => Number(id.trim())).filter(Number.isFinite);

    if (adminIds.length === 0) {
      await ctx.replyWithHTML('⛔ Команда отключена: не настроен <code>ADMIN_IDS</code> в .env.');
      return;
    }

    if (!isAdminUser(ctx.from.id)) {
      await ctx.replyWithHTML('⛔ Эта команда доступна только администратору.');
      return;
    }

    const text = (ctx.message.text || '').trim();
    const parts = text.split(/\s+/);
    const subcommand = (parts[1] || '').toLowerCase();
    const currentMonth = getCurrentMonthKey();
    const nextMonth = getNextMonthKey();

    if (!subcommand || subcommand === 'list' || subcommand === 'список') {
      let message = '📋 <b>Привязка таблиц</b>\n\n';
      message += `🗓 Активный месяц: <code>${esc(currentMonth)}</code>\n`;
      message += `🗓 Следующий месяц: <code>${esc(nextMonth)}</code>\n\n`;

      for (const workplace of workplaces) {
        const active = resolveSheetInfo(workplace);
        const currentId = getWorkplaceSheetIdByMonth(workplace, currentMonth);
        const nextId = getWorkplaceSheetIdByMonth(workplace, nextMonth);
        const sourceText = active.isMonthly
          ? 'помесячная привязка'
          : active.sheetId
            ? 'legacy (старый формат)'
            : 'не задано';

        message += `🏬 <b>${esc(workplace)}</b>\n`;
        message += `   Активная (${esc(currentMonth)}): <code>${esc(active.sheetId || 'не задана')}</code>\n`;
        message += `   Следующая (${esc(nextMonth)}): <code>${esc(nextId || 'не задана')}</code>\n`;
        message += `   Источник: ${esc(sourceText)}\n`;

        if (!currentId && active.noSheetForMonth) {
          message += '   ⚠️ На активный месяц таблица не привязана — запись блокируется\n';
        }

        if (!active.isMonthly) {
          message += '   ⚠️ Рекомендуется задать <code>active</code> и <code>next</code> вручную\n';
        }

        const knownMonths = Object.keys(getWorkplaceMonthMap(workplace)).sort();
        if (knownMonths.length > 0) {
          message += `   Месяцы в базе: ${esc(knownMonths.join(', '))}\n`;
        }

        message += '\n';
      }

      message += 'Команды:\n';
      message += '<code>/sheet east active URL</code> — добавить и сделать активной\n';
      message += '<code>/sheet east next URL</code> — добавить на следующий месяц\n';
      message += '<code>/sheet center active URL</code>\n';
      message += '<code>/sheet center next URL</code>\n';
      message += '<code>/sheet east URL</code> — авто по названию месяца\n';
      message += '<code>/sheet reset east active</code>\n';
      message += '<code>/sheet reset center next</code>';

      await ctx.replyWithHTML(message);
      return;
    }

    if (subcommand === 'reset') {
      const targetToken = (parts[2] || '').toLowerCase();
      const workplace = getWorkplaceFromToken(parts[2]);
      const resetTarget = (parts[3] || 'active').toLowerCase();

      if (targetToken === 'all' || targetToken === 'все') {
        await ctx.replyWithHTML(
          '⚠️ <b>Вы собираетесь сбросить привязки ВСЕХ таблиц для ВСЕХ магазинов.</b>\n\nЭто действие необратимо. Подтвердите:',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Да, сбросить всё', callback_data: 'sheet_reset_all_confirm' }],
                [{ text: '❌ Отмена', callback_data: 'close_message' }]
              ]
            }
          }
        );
        return;
      }

      if (!workplace) {
        await ctx.replyWithHTML('❌ Укажите магазин: <code>/sheet reset east active</code> или <code>/sheet reset center next</code> (или <code>/sheet reset all</code>).');
        return;
      }

      if (resetTarget === 'all' || resetTarget === 'все') {
        const monthMap = getWorkplaceMonthMap(workplace);
        for (const monthKey of Object.keys(monthMap)) {
          setWorkplaceSheetIdByMonth(workplace, monthKey, '');
        }
        setWorkplaceSheetId(workplace, '');
        await ctx.replyWithHTML(`✅ Все привязки для <b>${esc(workplace)}</b> сброшены.`);
        return;
      }

      const slot = parseSheetSlotToken(resetTarget);
      if (!slot) {
        await ctx.replyWithHTML('❌ Укажите режим: <code>active</code>, <code>next</code> или <code>YYYY-MM</code>.');
        return;
      }

      setWorkplaceSheetIdByMonth(workplace, slot.monthKey, '');
      await ctx.replyWithHTML(`✅ Привязка для <b>${esc(workplace)}</b> (${esc(slot.label)}: <code>${esc(slot.monthKey)}</code>) удалена.`);
      return;
    }

    const workplace = getWorkplaceFromToken(subcommand);
    if (!workplace) {
      await ctx.replyWithHTML(
        '❌ Укажите магазин:\n\n' +
        '<code>/sheet east active URL</code>\n' +
        '<code>/sheet center next URL</code>\n\n' +
        'Или <code>/sheet</code> для просмотра текущих таблиц.'
      );
      return;
    }

    const args = parts.slice(2);
    if (args.length === 0) {
      const active = resolveSheetInfo(workplace);
      const currentId = getWorkplaceSheetIdByMonth(workplace, currentMonth);
      const nextId = getWorkplaceSheetIdByMonth(workplace, nextMonth);
      await ctx.replyWithHTML(
        `📋 <b>${esc(workplace)}</b>\n\n` +
        `Активная (${esc(currentMonth)}): <code>${esc(active.sheetId || 'не задана')}</code>\n` +
        `Следующая (${esc(nextMonth)}): <code>${esc(nextId || 'не задана')}</code>\n\n` +
        'Пример:\n' +
        `<code>/sheet ${subcommand} active URL_ТАБЛИЦЫ</code>\n` +
        `<code>/sheet ${subcommand} next URL_ТАБЛИЦЫ</code>`
      );
      return;
    }

    let targetSlot = null;
    let monthKey = null;
    let sheetArg = '';

    const parsedSlot = parseSheetSlotToken(args[0]);
    if (parsedSlot) {
      targetSlot = parsedSlot.slot;
      monthKey = parsedSlot.monthKey;
      sheetArg = args.slice(1).join(' ');
    } else {
      sheetArg = args.join(' ');
    }

    const sheetId = extractSheetId(sheetArg);
    if (!sheetId) {
      await ctx.replyWithHTML('❌ Не удалось извлечь ID таблицы из ссылки.\n\nОтправьте ссылку вида:\n<code>https://docs.google.com/spreadsheets/d/...</code>');
      return;
    }

    const modeText = targetSlot === 'active'
      ? 'активная'
      : targetSlot === 'next'
        ? 'следующий месяц'
        : 'авто';

    await ctx.replyWithHTML(`⏳ Проверяю таблицу для <b>${esc(workplace)}</b> (режим: ${esc(modeText)})...`);

    try {
      const result = await verifySheetAccess(sheetId);

      if (!result.ok) {
        await ctx.replyWithHTML(
          `❌ <b>Ошибка доступа</b>\n\n${esc(result.error)}\n\n` +
          'Убедитесь, что:\n' +
          '1. Таблица существует\n' +
          '2. Дан доступ: <code>courier-shift-bot@courier-shift-bot.iam.gserviceaccount.com</code>\n' +
          '3. В таблице есть листы «Курьеры» и «Пробег» / «Пробег Курьеры»'
        );
        return;
      }

      const titleMonth = extractMonthKeyFromTitle(result.title);
      if (!monthKey) {
        if (!titleMonth) {
          await ctx.replyWithHTML(
            '⚠️ Не удалось определить месяц по названию таблицы.\n' +
            'Используйте явный режим:\n' +
            `<code>/sheet ${subcommand} active URL</code> или <code>/sheet ${subcommand} next URL</code>.`
          );
          return;
        }
        monthKey = titleMonth;
      }

      setWorkplaceSheetIdByMonth(workplace, monthKey, sheetId);

      const boundAs = monthKey === currentMonth
        ? 'активная таблица'
        : monthKey === nextMonth
          ? 'таблица на следующий месяц'
          : `таблица на ${monthKey}`;

      let message = `✅ <b>Таблица привязана!</b>\n\n` +
        `🏬 Магазин: <b>${esc(workplace)}</b>\n` +
        `🗂 Режим: <b>${esc(boundAs)}</b>\n` +
        `🗓 Месяц: <code>${esc(monthKey)}</code>\n` +
        `📊 Название: <b>${esc(result.title)}</b>\n` +
        `🆔 ID: <code>${esc(sheetId)}</code>`;

      if (titleMonth) {
        message += `\n\nℹ️ Месяц из названия таблицы: <code>${esc(titleMonth)}</code>.`;
        if (titleMonth !== monthKey) {
          message += ' Проверьте, что выбрали правильный режим (active/next).';
        }
      }

      const active = resolveSheetInfo(workplace);
      if (active.sheetId) {
        message += `\n\n✅ Активная сейчас (${esc(currentMonth)}): <code>${esc(active.sheetId)}</code>`;
      } else if (active.noSheetForMonth) {
        message += `\n\n⚠️ Для текущего месяца <code>${esc(active.monthKey)}</code> таблица не задана.`;
      }

      await ctx.replyWithHTML(message);
      console.log('sheet changed', workplace, monthKey, sheetId, result.title);
    } catch (error) {
      console.error('sheet command error', error);
      await ctx.replyWithHTML('⚠️ Произошла ошибка при проверке таблицы.\nПопробуйте ещё раз.');
    }
  });

  bot.action('sheet_reset_all_confirm', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) { await ctx.answerCbQuery(); return; }
    await ctx.answerCbQuery();
    for (const item of workplaces) {
      const monthMap = getWorkplaceMonthMap(item);
      for (const monthKey of Object.keys(monthMap)) {
        setWorkplaceSheetIdByMonth(item, monthKey, '');
      }
      setWorkplaceSheetId(item, '');
    }
    await ctx.editMessageText('✅ Все привязки для всех магазинов сброшены.', { parse_mode: 'HTML' });
  });
}

module.exports = {
  registerSheetCommand
};
