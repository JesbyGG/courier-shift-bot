const path = require("path");
const { Markup } = require("telegraf");
const { styledButton, computeCashAdjustment } = require("../utils");
const { WORKPLACES, DEVICES, LIMITS } = require("../config");
const { parseMoneyRu } = require("../services/reconciliationOcr");

// Интерактивная админ-панель (/admin). Доступ только для ADMIN_IDS.
// Разделы: наличные, карточка сотрудника, роль, профиль, рассылка, мониторинг.
module.exports = function setupAdminPanel(bot, services) {
  const {
    isAdminUser,
    getUserField,
    setUserField,
    getUserRole,
    getFullProfile,
    getAllUserIds,
    getPendingCash,
    setPendingCash,
    clearPendingCashAndReminders,
    logCashAction,
    getCashHistory,
    getDebtors,
    findLogistsForWorkplace,
    deleteUser,
    clearShiftStatus,
    getShiftStatus,
    addSheetAccessUser,
    removeSheetAccessUser,
    isSheetAccessUser,
    formatMoneyRu,
    roundMoney,
    MAX_REASONABLE_CASH_AMOUNT,
    normalizeFio,
    esc,
    setState,
    getState,
    clearState,
    getMenuForRole,
    getCurrentDateInfo,
    checkGeminiOcrHealth,
    getVersion,
    safeLog,
  } = services;

  const PAGE_SIZE = 8;
  const PICK_KINDS = "cash|card|role|edit|bco";

  // ===== общие хелперы =====

  async function guard(ctx) {
    if (!isAdminUser(ctx.from.id)) {
      try {
        await ctx.answerCbQuery("⛔ Только админ", { show_alert: true });
      } catch (e) {
        /* ignore */
      }
      return false;
    }
    return true;
  }

  function adminName(id) {
    return getUserField(id, "fio") || "Админ";
  }

  const toKop = (rub) => Math.round(Number(rub || 0) * 100);
  const fromKop = (kop) => Number(kop || 0) / 100;

  function todayStr() {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: process.env.APP_TIMEZONE || "Europe/Moscow",
    });
  }

  function shiftIcon(status) {
    if (status === "start") return "🟢 старт";
    if (status === "end") return "🔴 конец";
    if (status === "both") return "✅";
    return "—";
  }

  async function show(ctx, html, kb, edit) {
    const markup = kb ? kb.reply_markup : undefined;
    if (edit) {
      try {
        await ctx.editMessageText(html, {
          parse_mode: "HTML",
          reply_markup: markup,
        });
        return;
      } catch (e) {
        /* сообщение не изменилось/устарело — отправим новым */
      }
    }
    await ctx.reply(html, { parse_mode: "HTML", reply_markup: markup });
  }

  function panelMenu() {
    return Markup.inlineKeyboard([
      [
        styledButton("💵 Наличные", "apm:cash", "primary"),
        styledButton("👤 Карточка", "apm:card"),
      ],
      [
        styledButton("🔑 Роль", "apm:role"),
        styledButton("✏️ Профиль", "apm:edit"),
      ],
      [
        styledButton("📣 Рассылка", "apm:bcast"),
        styledButton("🩺 Мониторинг", "apm:mon"),
      ],
      [styledButton("❌ Закрыть", "close_message", "danger")],
    ]);
  }

  // ===== выбор сотрудника =====

  function buildEmployees(kind) {
    const ids = getAllUserIds();
    const list = [];
    for (const id of ids) {
      const p = getFullProfile(id);
      if (!p || !p.fio) continue;
      const role = p.role || "courier";
      if (kind === "cash" && role === "logist") continue; // наличные только у курьеров
      list.push({
        id: String(id),
        fio: p.fio,
        role,
        workplace: p.workplace || null,
      });
    }
    list.sort((a, b) => a.fio.localeCompare(b.fio, "ru"));
    return list;
  }

  function filterEmployees(list, query) {
    if (!query) return list;
    const q = normalizeFio(query);
    return list.filter((e) => normalizeFio(e.fio).includes(q));
  }

  async function renderEmployeeList(ctx, kind, page, edit) {
    const st = getState(ctx.from.id) || {};
    const query = st.adminPick && st.adminPick.kind === kind ? st.adminPick.query || "" : "";
    const all = filterEmployees(buildEmployees(kind), query);
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const p = Math.min(Math.max(0, page), totalPages - 1);
    const slice = all.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

    setState(ctx.from.id, { adminPick: { kind, query, page: p } });

    const rows = slice.map((e) => [
      styledButton(
        `👤 ${e.fio}${e.workplace ? " — " + e.workplace : ""}`,
        `ap:pk:${kind}:${e.id}`,
      ),
    ]);
    const nav = [];
    if (p > 0) nav.push(styledButton("◀️", `ap:pg:${kind}:${p - 1}`));
    if (p < totalPages - 1) nav.push(styledButton("▶️", `ap:pg:${kind}:${p + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([
      styledButton("🔎 Поиск", `ap:find:${kind}`),
      styledButton("◀️ Меню", "apm:home"),
    ]);
    rows.push([styledButton("❌ Закрыть", "close_message", "danger")]);

    const title =
      `👥 <b>Выбор сотрудника</b>${query ? `\n🔎 поиск: <i>${esc(query)}</i>` : ""}\n` +
      `Стр. ${p + 1}/${totalPages} · всего: ${all.length}` +
      (all.length === 0 ? "\n\nНичего не найдено." : "");
    await show(ctx, title, Markup.inlineKeyboard(rows), edit);
  }

  // ===== наличные =====

  function logAdminCash(ctx, courierId, action, amount, workplace) {
    const p = getFullProfile(courierId) || {};
    logCashAction({
      logistId: String(ctx.from.id),
      logistFio: adminName(ctx.from.id),
      courierId: String(courierId),
      courierFio: p.fio || "—",
      workplace: workplace || p.workplace || "—",
      amount,
      action,
    });
  }

  // Отправляет сотруднику сообщение ВМЕСТЕ с актуальной reply-клавиатурой,
  // чтобы его меню (кнопка «💵 Наличные {сумма}», кнопки роли и т.п.)
  // обновлялось сразу. Меню строится из текущего состояния, поэтому вызывать
  // нужно ПОСЛЕ обновления долга/роли/профиля.
  async function notifyAndRefresh(ctx, id, text) {
    try {
      await ctx.telegram.sendMessage(Number(id), text, {
        parse_mode: "HTML",
        reply_markup: getMenuForRole(id).reply_markup,
      });
    } catch (e) {
      /* пользователь мог заблокировать бота */
    }
  }

  async function notifyCourierCash(ctx, id, total) {
    const msg =
      total > 0
        ? `💵 Ваш долг по наличным обновлён администратором: <b>${formatMoneyRu(total)}</b> к сдаче.`
        : "✅ Ваш долг по наличным обнулён администратором.";
    await notifyAndRefresh(ctx, id, msg);
  }

  async function showCashScreen(ctx, id, edit) {
    const p = getFullProfile(id) || {};
    const pc = getPendingCash(id);
    const amount = Number(pc && pc.amount ? pc.amount : 0);
    const html =
      `💵 <b>Наличные</b>\n` +
      `👤 ${esc(p.fio || id)}\n` +
      `🏬 ${esc(p.workplace || "—")}\n\n` +
      `Текущий долг к сдаче: <b>${formatMoneyRu(amount)}</b>`;
    const kb = Markup.inlineKeyboard([
      [
        styledButton("➕ Добавить", `ap:cash:add:${id}`, "success"),
        styledButton("➖ Убавить", `ap:cash:sub:${id}`),
      ],
      [
        styledButton("✏️ Задать", `ap:cash:set:${id}`, "primary"),
        styledButton("🗑 Обнулить", `ap:cash:clr:${id}`, "danger"),
      ],
      [
        styledButton("◀️ Список", `ap:pg:cash:0`),
        styledButton("❌ Закрыть", "close_message", "danger"),
      ],
    ]);
    await show(ctx, html, kb, edit);
  }

  async function askHistory(ctx, id, sumRub, workplace) {
    const kop = toKop(sumRub);
    const kb = Markup.inlineKeyboard([
      [
        styledButton("✅ Да", `ap:hist:${id}:${kop}`, "success"),
        styledButton("❌ Нет", "ap:nohist", "danger"),
      ],
    ]);
    await ctx.reply(
      `📋 Записать списание ${formatMoneyRu(sumRub)} в историю сборов (её видит логист)?`,
      { reply_markup: kb.reply_markup },
    );
  }

  // ===== карточка =====

  async function showCardScreen(ctx, id, edit) {
    const p = getFullProfile(id) || {};
    const pc = getPendingCash(id);
    const debt = Number(pc && pc.amount ? pc.amount : 0);
    const cashSubmits = getUserField(id, "cashSubmits") || 0;
    const mil = getUserField(id, "mileageRecords") || 0;
    const rs = getUserField(id, "routeSheetsSubmitted") || 0;
    const roleName = (p.role || "courier") === "logist" ? "Логист" : "Курьер";

    const lines = [
      `👤 <b>${esc(p.fio || id)}</b>`,
      `🆔 <code>${id}</code>`,
      `🔑 ${roleName}`,
      `🏬 ${esc(p.workplace || "—")}`,
    ];
    if ((p.role || "courier") !== "logist") {
      lines.push(
        `🚗 ${esc(p.carNumber || "—")} · 📱 ${esc(p.device || "—")} · ${
          p.courierType === "pedestrian" ? "🚶 пеший" : "🚗 авто"
        }`,
      );
    }
    lines.push("");
    lines.push(`💵 Долг: <b>${formatMoneyRu(debt)}</b>`);
    lines.push(`📊 Сдач: ${cashSubmits} · Пробегов: ${mil} · Маршрутников: ${rs}`);
    lines.push(
      `⏱ Смена: время ${shiftIcon(getShiftStatus(id, "time"))} · пробег ${shiftIcon(
        getShiftStatus(id, "mileage"),
      )}`,
    );

    const kb = Markup.inlineKeyboard([
      [
        styledButton("💵 Наличные", `ap:pk:cash:${id}`, "primary"),
        styledButton("🔑 Роль", `ap:pk:role:${id}`),
      ],
      [styledButton("✏️ Профиль", `ap:pk:edit:${id}`)],
      [
        styledButton("◀️ Меню", "apm:home"),
        styledButton("❌ Закрыть", "close_message", "danger"),
      ],
    ]);
    await show(ctx, lines.join("\n"), kb, edit);
  }

  // ===== роль =====

  async function showRoleScreen(ctx, id, edit) {
    const p = getFullProfile(id) || {};
    const cur = (p.role || "courier") === "logist" ? "Логист" : "Курьер";
    const kb = Markup.inlineKeyboard([
      [
        styledButton("👤 Курьер", `ap:role:courier:${id}`, "primary"),
        styledButton("📦 Логист", `ap:role:logist:${id}`, "primary"),
      ],
      [
        styledButton("◀️ Меню", "apm:home"),
        styledButton("❌ Закрыть", "close_message", "danger"),
      ],
    ]);
    await show(
      ctx,
      `🔑 <b>Роль</b>\n👤 ${esc(p.fio || id)}\nТекущая: <b>${cur}</b>\n\nВыберите новую роль:`,
      kb,
      edit,
    );
  }

  // ===== профиль (редактирование) =====

  async function showEditScreen(ctx, id, edit) {
    const p = getFullProfile(id) || {};
    const sheet = isSheetAccessUser(id) ? "✅" : "❌";
    const kb = Markup.inlineKeyboard([
      [
        styledButton("🏪 Магазин", `ap:edit:wp:${id}`),
        styledButton("📱 Устройство", `ap:edit:dev:${id}`),
      ],
      [
        styledButton("🚗 Машина", `ap:edit:car:${id}`),
        styledButton(
          p.courierType === "pedestrian" ? "🚗 Сделать авто" : "🚶 Сделать пешим",
          `ap:edit:type:${id}`,
        ),
      ],
      [styledButton(`📋 Доступ к таблицам ${sheet}`, `ap:edit:sheet:${id}`)],
      [styledButton("🗑 Удалить сотрудника", `ap:edit:del:${id}`, "danger")],
      [
        styledButton("◀️ Меню", "apm:home"),
        styledButton("❌ Закрыть", "close_message", "danger"),
      ],
    ]);
    const html =
      `✏️ <b>Профиль</b>\n` +
      `👤 ${esc(p.fio || id)}\n` +
      `🏬 ${esc(p.workplace || "—")} · 📱 ${esc(p.device || "—")} · 🚗 ${esc(
        p.carNumber || "—",
      )}\n` +
      `Тип: ${p.courierType === "pedestrian" ? "пеший" : "авто"}`;
    await show(ctx, html, kb, edit);
  }

  // ===== рассылка =====

  function broadcastRecipients(audience) {
    if (audience.type === "one") return [String(audience.id)];
    const ids = getAllUserIds();
    const out = [];
    for (const id of ids) {
      const p = getFullProfile(id);
      if (!p || !p.fio) continue;
      if (audience.type === "wp" && p.workplace !== audience.workplace) continue;
      out.push(String(id));
    }
    return out;
  }

  function audienceLabel(audience) {
    if (audience.type === "all") return "всем";
    if (audience.type === "wp") return `магазин «${audience.workplace}»`;
    if (audience.type === "one") {
      const fio = getUserField(audience.id, "fio") || audience.id;
      return `сотруднику ${fio}`;
    }
    return "—";
  }

  // ===== мониторинг =====

  async function showMonitoring(ctx, edit) {
    const ids = getAllUserIds();
    let couriers = 0;
    let logists = 0;
    let activeToday = 0;
    const day = todayStr();
    for (const id of ids) {
      const p = getFullProfile(id);
      if (!p || !p.fio) continue;
      if ((p.role || "courier") === "logist") logists++;
      else couriers++;
      const ls = getUserField(id, "lastSeen");
      if (ls && String(ls).slice(0, 10) === day) activeToday++;
    }

    let debtCount = 0;
    let debtSum = 0;
    for (const wp of WORKPLACES) {
      for (const d of getDebtors(wp)) {
        debtCount++;
        debtSum += Number(d.amount || 0);
      }
    }

    let collected = 0;
    let collCount = 0;
    for (const r of getCashHistory(day)) {
      if (["approved", "self_cleared", "logist_approved"].includes(r.action)) {
        collected += Number(r.amount || 0);
        collCount++;
      }
    }

    let ocrOk = false;
    try {
      ocrOk = await checkGeminiOcrHealth();
    } catch (e) {
      ocrOk = false;
    }
    let version = "—";
    try {
      version = (typeof getVersion === "function" && getVersion()) || "—";
    } catch (e) {
      /* ignore */
    }

    const html =
      `🩺 <b>Мониторинг</b>\n\n` +
      `🤖 Бот: онлайн\n` +
      `📦 Версия: <code>${esc(String(version))}</code>\n` +
      `🔍 OCR-сервер: ${ocrOk ? "✅ ok" : "❌ недоступен"}\n\n` +
      `👥 Пользователей: ${ids.length} (курьеров ${couriers}, логистов ${logists})\n` +
      `🟢 Активны сегодня: ${activeToday}\n` +
      `💵 Должников: ${debtCount} на ${formatMoneyRu(debtSum)}\n` +
      `📥 Собрано сегодня: ${collCount} на ${formatMoneyRu(collected)}`;
    const kb = Markup.inlineKeyboard([
      [
        styledButton("🔄 Обновить", "ap:mon:ref"),
        styledButton("💾 Бэкап БД", "ap:mon:bak"),
      ],
      [
        styledButton("◀️ Меню", "apm:home"),
        styledButton("❌ Закрыть", "close_message", "danger"),
      ],
    ]);
    await show(ctx, html, kb, edit);
  }

  // ========================================================================
  // Команда входа
  // ========================================================================

  bot.command("admin", async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    clearState(ctx.from.id);
    await ctx.replyWithHTML(
      "🛠 <b>Админ-панель</b>\n\nВыберите раздел:",
      panelMenu(),
    );
  });

  bot.action("apm:home", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    await show(ctx, "🛠 <b>Админ-панель</b>\n\nВыберите раздел:", panelMenu(), true);
  });

  // Открыть выбор сотрудника для раздела
  bot.action(/^apm:(cash|card|role|edit)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const kind = ctx.match[1];
    setState(ctx.from.id, { adminPick: { kind, query: "", page: 0 } });
    await renderEmployeeList(ctx, kind, 0, true);
  });

  // Пагинация / поиск
  bot.action(new RegExp(`^ap:pg:(${PICK_KINDS}):(\\d+)$`), async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    await renderEmployeeList(ctx, ctx.match[1], Number(ctx.match[2]), true);
  });

  bot.action(new RegExp(`^ap:find:(${PICK_KINDS})$`), async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaitingAdminSearch: { kind: ctx.match[1] } });
    await ctx.replyWithHTML("🔎 Введите часть ФИО для поиска:");
  });

  // Выбор конкретного сотрудника
  bot.action(new RegExp(`^ap:pk:(${PICK_KINDS}):(\\d+)$`), async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const kind = ctx.match[1];
    const id = ctx.match[2];
    if (kind === "cash") return showCashScreen(ctx, id, true);
    if (kind === "card") return showCardScreen(ctx, id, true);
    if (kind === "role") return showRoleScreen(ctx, id, true);
    if (kind === "edit") return showEditScreen(ctx, id, true);
    if (kind === "bco") {
      setState(ctx.from.id, {
        awaitingAdminBroadcast: { audience: { type: "one", id } },
      });
      const fio = getUserField(id, "fio") || id;
      await ctx.replyWithHTML(
        `📣 Введите текст сообщения для <b>${esc(fio)}</b>:`,
      );
      return;
    }
  });

  // ---- наличные: операции ----

  bot.action(/^ap:cash:(add|sub|set):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const op = ctx.match[1];
    const id = ctx.match[2];
    setState(ctx.from.id, { awaitingAdminCashAmount: { op, courierId: id } });
    const label = op === "add" ? "добавить" : op === "sub" ? "убавить" : "задать";
    await ctx.replyWithHTML(
      `💵 Введите сумму (₽), чтобы <b>${label}</b> долг сотрудника:`,
    );
  });

  bot.action(/^ap:cash:clr:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const pc = getPendingCash(id);
    const prior = roundMoney(Number(pc && pc.amount ? pc.amount : 0));
    if (prior <= 0) {
      await ctx.replyWithHTML("ℹ️ У сотрудника нет долга по наличным.");
      return;
    }
    const p = getFullProfile(id) || {};
    const wp = p.workplace || (pc && pc.workplace) || null;
    clearPendingCashAndReminders(id);
    logAdminCash(ctx, id, "admin_cleared", 0, wp);
    await notifyCourierCash(ctx, id, 0);
    await ctx.replyWithHTML(
      `✅ Долг сотрудника <b>${esc(p.fio || id)}</b> обнулён (было ${formatMoneyRu(prior)}).`,
    );
    await askHistory(ctx, id, prior, wp);
  });

  // ---- наличные: запись в историю сборов ----

  bot.action("ap:nohist", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery("Ок");
    try {
      await ctx.editMessageText("☑️ В историю сборов не записано.");
    } catch (e) {
      /* ignore */
    }
  });

  bot.action(/^ap:hist:(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const kop = ctx.match[2];
    const p = getFullProfile(id) || {};
    const wp = p.workplace || null;
    const logists = wp ? findLogistsForWorkplace(wp) : [];
    const rows = logists.map((l) => [
      styledButton(`📦 ${l.fio}`, `ap:col:${l.telegramId}:${id}:${kop}`),
    ]);
    rows.push([styledButton("🧑‍💼 От имени Админ", `ap:coladm:${id}:${kop}`)]);
    rows.push([styledButton("❌ Отмена", "ap:nohist", "danger")]);
    await show(
      ctx,
      `👤 На какого логиста записать сбор ${formatMoneyRu(fromKop(kop))}?`,
      Markup.inlineKeyboard(rows),
      true,
    );
  });

  bot.action(/^ap:col:(\d+):(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const lid = ctx.match[1];
    const id = ctx.match[2];
    const sum = fromKop(ctx.match[3]);
    const p = getFullProfile(id) || {};
    const lfio = getUserField(lid, "fio") || "Логист";
    logCashAction({
      logistId: String(lid),
      logistFio: lfio,
      courierId: String(id),
      courierFio: p.fio || "—",
      workplace: p.workplace || "—",
      amount: sum,
      action: "logist_approved",
    });
    try {
      await ctx.editMessageText(
        `✅ Сбор ${formatMoneyRu(sum)} записан в историю на логиста ${lfio}.`,
      );
    } catch (e) {
      /* ignore */
    }
  });

  bot.action(/^ap:coladm:(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const sum = fromKop(ctx.match[2]);
    const p = getFullProfile(id) || {};
    logCashAction({
      logistId: String(ctx.from.id),
      logistFio: adminName(ctx.from.id),
      courierId: String(id),
      courierFio: p.fio || "—",
      workplace: p.workplace || "—",
      amount: sum,
      action: "logist_approved",
    });
    try {
      await ctx.editMessageText(
        `✅ Сбор ${formatMoneyRu(sum)} записан в историю (от имени Админ).`,
      );
    } catch (e) {
      /* ignore */
    }
  });

  // ---- роль ----

  bot.action(/^ap:role:(courier|logist):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const role = ctx.match[1];
    const id = ctx.match[2];
    const fio = getUserField(id, "fio");
    if (!fio) {
      await ctx.answerCbQuery("Сотрудник не найден", { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    setUserField(id, "role", role);
    if (role === "logist") {
      if (getUserField(id, "carNumber")) setUserField(id, "carNumber", null);
      if (getUserField(id, "device")) setUserField(id, "device", null);
    }
    // Новое меню роли приходит сразу вместе с уведомлением (reply-клавиатура).
    await notifyAndRefresh(
      ctx,
      id,
      `🔑 Ваша роль изменена: <b>${role === "logist" ? "Логист" : "Курьер"}</b>`,
    );
    try {
      await ctx.editMessageText(
        `✅ Роль сотрудника <b>${esc(fio)}</b>: ${role === "logist" ? "Логист" : "Курьер"}`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      /* ignore */
    }
  });

  // ---- профиль ----

  bot.action(/^ap:edit:wp:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const rows = WORKPLACES.map((w, i) => [
      styledButton(`🏪 ${w}`, `ap:swp:${id}:${i}`),
    ]);
    rows.push([styledButton("◀️ Назад", `ap:pk:edit:${id}`)]);
    await show(ctx, "🏪 Выберите магазин:", Markup.inlineKeyboard(rows), true);
  });

  bot.action(/^ap:swp:(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery("Магазин обновлён");
    const id = ctx.match[1];
    const wp = WORKPLACES[Number(ctx.match[2])];
    if (wp) {
      setUserField(id, "workplace", wp);
      // Магазин влияет на меню логиста (кнопки Наличные/История) — обновляем.
      await notifyAndRefresh(
        ctx,
        id,
        `🏬 Ваш магазин изменён администратором: <b>${esc(wp)}</b>`,
      );
    }
    await showEditScreen(ctx, id, true);
  });

  bot.action(/^ap:edit:dev:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const rows = DEVICES.map((d, i) => [
      styledButton(`📱 ${d}`, `ap:sdev:${id}:${i}`),
    ]);
    rows.push([styledButton("◀️ Назад", `ap:pk:edit:${id}`)]);
    await show(ctx, "📱 Выберите устройство:", Markup.inlineKeyboard(rows), true);
  });

  bot.action(/^ap:sdev:(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery("Устройство обновлено");
    const id = ctx.match[1];
    const dev = DEVICES[Number(ctx.match[2])];
    if (dev) setUserField(id, "device", dev);
    await showEditScreen(ctx, id, true);
  });

  bot.action(/^ap:edit:type:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery("Тип обновлён");
    const id = ctx.match[1];
    const cur = getUserField(id, "courierType") || "auto";
    setUserField(id, "courierType", cur === "pedestrian" ? "auto" : "pedestrian");
    // Тип курьера влияет на reply-меню (наличие кнопки пробега) — обновляем.
    await notifyAndRefresh(ctx, id, "ℹ️ Ваш профиль обновлён администратором.");
    await showEditScreen(ctx, id, true);
  });

  bot.action(/^ap:edit:car:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    setState(ctx.from.id, { awaitingAdminEditCar: { courierId: id } });
    await ctx.replyWithHTML("🚗 Введите номер машины:");
  });

  bot.action(/^ap:edit:sheet:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const id = ctx.match[1];
    if (isSheetAccessUser(id)) {
      removeSheetAccessUser(id);
      await ctx.answerCbQuery("Доступ к таблицам убран");
    } else {
      addSheetAccessUser(id);
      await ctx.answerCbQuery("Доступ к таблицам выдан");
    }
    await showEditScreen(ctx, id, true);
  });

  bot.action(/^ap:edit:del:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const fio = getUserField(id, "fio") || id;
    const kb = Markup.inlineKeyboard([
      [styledButton("✅ Да, удалить", `ap:delok:${id}`, "danger")],
      [styledButton("◀️ Отмена", `ap:pk:edit:${id}`)],
    ]);
    await show(
      ctx,
      `🗑 Удалить сотрудника <b>${esc(fio)}</b>?\nЭто удалит профиль, долг и статус смены.`,
      kb,
      true,
    );
  });

  bot.action(/^ap:delok:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const fio = getUserField(id, "fio") || id;
    clearPendingCashAndReminders(id);
    clearShiftStatus(id);
    deleteUser(id);
    try {
      await ctx.editMessageText(`🗑 Сотрудник ${esc(fio)} удалён.`, {
        parse_mode: "HTML",
      });
    } catch (e) {
      /* ignore */
    }
  });

  // ---- рассылка ----

  bot.action("apm:bcast", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const kb = Markup.inlineKeyboard([
      [styledButton("📢 Всем", "ap:bc:all", "primary")],
      [styledButton("🏪 По магазину", "ap:bc:wp")],
      [styledButton("👤 Одному", "ap:bc:one")],
      [
        styledButton("◀️ Меню", "apm:home"),
        styledButton("❌ Закрыть", "close_message", "danger"),
      ],
    ]);
    await show(ctx, "📣 <b>Рассылка</b>\n\nВыберите аудиторию:", kb, true);
  });

  bot.action("ap:bc:all", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaitingAdminBroadcast: { audience: { type: "all" } } });
    await ctx.replyWithHTML("📣 Введите текст сообщения для рассылки <b>всем</b>:");
  });

  bot.action("ap:bc:wp", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const rows = WORKPLACES.map((w, i) => [
      styledButton(`🏪 ${w}`, `ap:bcw:${i}`),
    ]);
    rows.push([styledButton("◀️ Назад", "apm:bcast")]);
    await show(ctx, "🏪 Выберите магазин для рассылки:", Markup.inlineKeyboard(rows), true);
  });

  bot.action(/^ap:bcw:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const wp = WORKPLACES[Number(ctx.match[1])];
    setState(ctx.from.id, {
      awaitingAdminBroadcast: { audience: { type: "wp", workplace: wp } },
    });
    await ctx.replyWithHTML(
      `📣 Введите текст сообщения для магазина <b>${esc(wp)}</b>:`,
    );
  });

  bot.action("ap:bc:one", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { adminPick: { kind: "bco", query: "", page: 0 } });
    await renderEmployeeList(ctx, "bco", 0, true);
  });

  bot.action("ap:bcgo", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    const st = getState(ctx.from.id) || {};
    const draft = st.adminBroadcast;
    if (!draft || !draft.text) {
      try {
        await ctx.editMessageText("⚠️ Текст рассылки не найден.");
      } catch (e) {
        /* ignore */
      }
      return;
    }
    clearState(ctx.from.id);
    const recipients = broadcastRecipients(draft.audience);
    try {
      await ctx.editMessageText("📤 Отправляю...");
    } catch (e) {
      /* ignore */
    }
    let ok = 0;
    let fail = 0;
    for (const rid of recipients) {
      try {
        await ctx.telegram.sendMessage(Number(rid), draft.text);
        ok++;
      } catch (e) {
        fail++;
      }
    }
    await ctx.replyWithHTML(
      `✅ Рассылка завершена.\nДоставлено: <b>${ok}</b>, ошибок: <b>${fail}</b>.`,
    );
  });

  bot.action("ap:bcx", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery("Отменено");
    clearState(ctx.from.id);
    try {
      await ctx.editMessageText("❌ Рассылка отменена.");
    } catch (e) {
      /* ignore */
    }
  });

  // ---- мониторинг ----

  bot.action("apm:mon", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery();
    await showMonitoring(ctx, true);
  });

  bot.action("ap:mon:ref", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery("Обновлено");
    await showMonitoring(ctx, true);
  });

  bot.action("ap:mon:bak", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCbQuery("Готовлю файл...");
    const dbPath = path.join(__dirname, "..", "database.sqlite");
    try {
      await ctx.replyWithDocument({
        source: dbPath,
        filename: `backup-${todayStr()}.sqlite`,
      });
    } catch (e) {
      safeLog.error("admin backup send error", e.message);
      await ctx.replyWithHTML("⚠️ Не удалось отправить файл БД.");
    }
  });

  // ========================================================================
  // Обработчики ввода текста (вызываются из textRouter по состоянию)
  // ========================================================================

  async function handleAdminSearch(ctx, state, text) {
    if (!isAdminUser(ctx.from.id)) return;
    const kind = (state.awaitingAdminSearch && state.awaitingAdminSearch.kind) || "card";
    const query = String(text || "").trim();
    setState(ctx.from.id, { adminPick: { kind, query, page: 0 } });
    await renderEmployeeList(ctx, kind, 0, false);
  }

  async function handleAdminCashAmount(ctx, state, text) {
    if (!isAdminUser(ctx.from.id)) return;
    const { op, courierId } = state.awaitingAdminCashAmount;
    const amt = parseMoneyRu(text);
    if (
      amt === null ||
      !Number.isFinite(amt) ||
      amt < 0 ||
      amt > MAX_REASONABLE_CASH_AMOUNT
    ) {
      await ctx.replyWithHTML(
        `❌ Неверная сумма. Введите число от 0 до ${MAX_REASONABLE_CASH_AMOUNT}.`,
      );
      return;
    }
    const pc = getPendingCash(courierId);
    const prior = roundMoney(Number(pc && pc.amount ? pc.amount : 0));
    const p = getFullProfile(courierId) || {};
    const wp = p.workplace || (pc && pc.workplace) || null;

    const { total, action, reduced } = computeCashAdjustment(op, prior, amt);

    clearState(ctx.from.id);

    if (total <= 0) {
      clearPendingCashAndReminders(courierId);
    } else {
      setPendingCash(courierId, {
        amount: total,
        formatted: formatMoneyRu(total),
        orders: (pc && pc.orders) || null,
        workplace: wp,
        sourceLabel: "admin",
        confirmationStatus: null,
        updatedAt: new Date().toISOString(),
        fileId: (pc && pc.fileId) || null,
      });
    }

    logAdminCash(ctx, courierId, action, total, wp);
    await notifyCourierCash(ctx, courierId, total);
    await ctx.replyWithHTML(
      `✅ Готово. Долг сотрудника <b>${esc(p.fio || courierId)}</b>: <b>${formatMoneyRu(total)}</b>`,
    );

    // Списание (➖) — предложить запись в историю сборов
    if (op === "sub" && reduced > 0) {
      await askHistory(ctx, courierId, reduced, wp);
    }
  }

  async function handleAdminBroadcast(ctx, state, text) {
    if (!isAdminUser(ctx.from.id)) return;
    const audience = state.awaitingAdminBroadcast.audience;
    const body = String(text || "").trim();
    if (!body) {
      await ctx.replyWithHTML("⚠️ Пустой текст. Введите сообщение:");
      return;
    }
    setState(ctx.from.id, { adminBroadcast: { audience, text: body } });
    const count = broadcastRecipients(audience).length;
    const kb = Markup.inlineKeyboard([
      [
        styledButton("✅ Отправить", "ap:bcgo", "success"),
        styledButton("❌ Отмена", "ap:bcx", "danger"),
      ],
    ]);
    await ctx.replyWithHTML(
      `📣 <b>Превью рассылки</b>\nАудитория: ${esc(audienceLabel(audience))} (${count} чел.)\n\n${esc(body)}`,
      kb,
    );
  }

  async function handleAdminEditCar(ctx, state, text) {
    if (!isAdminUser(ctx.from.id)) return;
    const id = state.awaitingAdminEditCar.courierId;
    const car = String(text || "").trim();
    const min = (LIMITS && LIMITS.CAR_NUMBER_MIN_LENGTH) || 4;
    const max = (LIMITS && LIMITS.CAR_NUMBER_MAX_LENGTH) || 12;
    if (car.length < min || car.length > max) {
      await ctx.replyWithHTML(
        `❌ Номер машины должен быть от ${min} до ${max} символов.`,
      );
      return;
    }
    setUserField(id, "carNumber", car);
    clearState(ctx.from.id);
    await ctx.replyWithHTML(`✅ Номер машины обновлён: <code>${esc(car)}</code>`);
    await showEditScreen(ctx, id, false);
  }

  // Прокидываем текстовые обработчики в общий services, чтобы textRouter
  // (регистрируется после этого модуля) мог вызывать их по состоянию.
  Object.assign(services, {
    handleAdminSearch,
    handleAdminCashAmount,
    handleAdminBroadcast,
    handleAdminEditCar,
  });
};
