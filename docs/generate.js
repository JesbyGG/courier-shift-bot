const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────
// СОДЕРЖАНИЕ ДЛЯ ОБОИХ ДОКУМЕНТОВ (HTML + Word)
// ─────────────────────────────────────────────────────

const TITLE = 'Telegram-бот для учёта смен курьеров';
const SUBTITLE = 'Как это работает — описание для руководителя';
const DATE = new Date().toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });

const roles = [
  {
    name: 'Курьер',
    emoji: '👤',
    desc: 'Сотрудник, который выходит на доставку. С помощью бота отмечает начало и конец смены, отправляет фото пробега, маршрутные листы и сверки, взаимодействует с логистом по наличным.',
    buttons: [
      { btn: '⏱ Записать время', text: 'Нажать в начале и в конце смены. Бот сам запишет время в таблицу.' },
      { btn: '🚗 Фото пробега', text: 'Сфотографировать приборку — бот сам распознаёт цифры, отправляет фото в чат и записывает пробег.' },
      { btn: '📄 Маршрутник', text: 'Отправить фото маршрутного листа — бот перешлёт в нужный чат.' },
      { btn: '📊 Отправить сверку', text: 'Сфотографировать чек терминала или пин-панели. Бот распознаёт количество заказов и сумму наличных, отправляет в чат.' },
      { btn: '💵 Сдать наличные', text: 'Бот показывает, сколько накопилось к сдаче. После подтверждения отправляет запрос логисту.' },
      { btn: '🏆 Рейтинг', text: 'Посмотреть своё место среди коллег: сегодня, за неделю, за месяц. Можно выбрать магазин.' },
      { btn: '⚠️ Проблема с заказом', text: 'Ссылки на чаты поддержки, если случилась проблема.' },
      { btn: '⚙️ Настройки', text: 'Профиль, номер машины, магазин, устройство.' }
    ]
  },
  {
    name: 'Логист',
    emoji: '📦',
    desc: 'Сотрудник, который контролирует смены и сбор наличных. Не выезжает на доставку, работает через бота удалённо.',
    buttons: [
      { btn: '⏱ Записать время', text: 'Отметить начало и конец смены.' },
      { btn: '🔓 Открыть ИМ', text: 'Одной кнопкой отправить в группу уведомление: «ИМ Восток — ОТКРЫТ». Все видят, что магазин работает.' },
      { btn: '💳 Принять наличные', text: 'Посмотреть, кто из курьеров должен деньги. Нажать на фамилию — курьеру придёт напоминание.' },
      { btn: '📋 История сборов', text: 'Посмотреть, кто и когда сдал наличные за последние 7 дней.' },
      { btn: '⚙️ Настройки', text: 'Поменять магазин, сотрудника, посмотреть свой ID.' }
    ]
  }
];

const processes = [
  {
    title: 'Начало смены',
    story: 'Курьер пришёл на работу. Открывает бота, нажимает кнопку — смена началась.',
    dialog: [
      { who: 'Курьер', text: 'нажимает «⏱ Записать время» → «🟢 Начать смену»' },
      { who: 'Бот', text: '✅ Смена начата: 09:00\n🟢 Старт: 09:00\n🏬 ИМ Восток' },
    ],
    note: 'Время записывается в общую таблицу. Руководитель видит, кто вышел и во сколько. В конце смены курьер нажимает «Закончить смену» — так же автоматически.'
  },
  {
    title: 'Фото пробега',
    story: 'Курьер сфотографировал приборку в начале смены и отправил боту.',
    dialog: [
      { who: 'Курьер', text: 'нажимает «🚗 Фото пробега» → отправляет фото' },
      { who: 'Бот', text: '📸 Распознан пробег: 54 321 км\n\n🟢 Начало смены: 09:00\n🚗 Пробег старт: 54 321 км' },
    ],
    note: 'Бот сам «читает» цифры с фото. Если распознать не удалось — предложит ввести пробег вручную или загрузить фото заново. Фото автоматически отправляется в рабочий чат, где его видят все.'
  },
  {
    title: 'Сверка + Накопление наличных',
    story: 'В конце смены курьер фотографирует чек терминала (или пин-панели) — бот распознаёт, сколько заказов сделано и сколько наличных нужно сдать.',
    dialog: [
      { who: 'Курьер', text: 'нажимает «📊 Отправить сверку» → отправляет фото чека' },
      { who: 'Бот', text: '📊 Сверка — Терминал\n👤 Иванов Иван\n🏬 ИМ Восток\n\nЗаказы: 24\nНаличные: 15 200 ₽' },
      { who: 'После этого', text: 'Курьер видит в меню: 💵 К сдаче: 15 200 ₽' },
    ],
    note: 'Заказы идут в рейтинг курьеров. Наличные копятся — в конце дня или по запросу логиста курьер нажимает «Сдать наличные».'
  },
  {
    title: 'Сдача наличных — курьер инициирует',
    story: 'Курьер нажимает «Сдать наличные», подтверждает сумму — бот отправляет запрос логисту.',
    dialog: [
      { who: 'Курьер', text: 'нажимает «💵 Сдать наличные» → «✅ Да, сдал»' },
      { who: 'Бот — курьеру', text: '⏳ Запрос отправлен. Ожидайте подтверждения логиста.' },
      { who: 'Бот — логисту', text: '💰 Курьер отметил сдачу\n\n👤 Иванов Иван\n💵 15 200 ₽\n🏬 ИМ Восток\n\nПодтвердите сдачу:\n[✅ Подтвердить] [❌ Отклонить]' },
      { who: 'Логист', text: 'нажимает «✅ Подтвердить»' },
      { who: 'Бот — курьеру', text: '✅ Логист Петров подтвердил сдачу 15 200 ₽\n\nСпасибо!' },
    ],
    note: 'Без подтверждения логиста сдача не засчитывается. Это гарантирует, что деньги реально сданы, а не просто отмечены в боте.'
  },
  {
    title: 'Сдача наличных — логист напоминает',
    story: 'Логист видит список должников, нажимает на фамилию — курьеру приходит напоминание.',
    dialog: [
      { who: 'Логист', text: 'нажимает «💳 Принять наличные»' },
      { who: 'Бот — логисту', text: '💳 Курьеры с долгами (ИМ Восток)\nВсего к сдаче: 34 700 ₽\n\n👤 Иванов Иван — 15 200 ₽\n👤 Петров Сергей — 19 500 ₽' },
      { who: 'Логист', text: 'нажимает на «Иванов Иван»' },
      { who: 'Бот — курьеру', text: '🔔 Логист Петров напоминает:\n\n💵 У вас 15 200 ₽ к сдаче.\n\n[🏃 Уже бегу] [✅ Сдал]' },
      { who: 'Курьер', text: 'нажимает «🏃 Уже бегу»' },
      { who: 'Бот — логисту', text: '🏃 Иванов Иван уже бежит сдавать 15 200 ₽' },
    ],
    note: 'Логист видит, кто отреагировал, а кто нет. Если курьер нажал «Сдал» — логист подтверждает или отклоняет.'
  },
  {
    title: 'Открытие магазина (логист)',
    story: 'Логист открывает магазин и одним нажатием оповещает всю группу.',
    dialog: [
      { who: 'Логист', text: 'нажимает «🔓 Открыть ИМ»' },
      { who: 'Бот — логисту', text: '✅ Уведомление отправлено: ИМ Восток — ОТКРЫТ ✅' },
      { who: 'Бот — в группу', text: '🏪 ИМ Восток — ОТКРЫТ ✅\n\nЛогист: Иванов Иван' },
    ],
    note: 'Все сотрудники в группе видят, что магазин открыт. Никому не нужно писать отдельно.'
  },
  {
    title: 'Рейтинг и уведомления об обгонах',
    story: 'После каждой сверки заказы попадают в рейтинг. Курьер может в любой момент посмотреть, кто лидирует.',
    dialog: [
      { who: 'Курьер', text: 'нажимает «🏆 Рейтинг» → выбирает «ИМ Восток», «Топ за сегодня»' },
      { who: 'Бот', text: '🏆 Рейтинг — ИМ Восток\nТоп за сегодня:\n\n🥇 1. Иванов — 24 заказа\n🥈 2. Петров — 18 заказов\n🥉 3. Сидоров — 15 заказов' },
      { who: 'Если курьер побил свой рекорд:', text: '' },
      { who: 'Бот — курьеру', text: '🎉 Новый личный рекорд!\n\nВы доставили 24 заказа за день!\nПредыдущий рекорд: 20 заказов.' },
      { who: 'Если кого-то обогнали:', text: '' },
      { who: 'Бот — обогнанному', text: '⚠️ Вас обогнали в рейтинге!\n\nИванов Иван доставил 24 заказа.' },
      { who: 'Бот — кто обогнал', text: '🎉 Вы обогнали в рейтинге: Петров С. (18 заказов)' },
    ],
    note: 'Рейтинг считается только по тем, кто работает в одном магазине. Каждый видит своё место и может стремиться к лучшему.'
  }
];

const benefits = [
  { icon: '✅', title: 'Автоматизация', desc: 'Сотрудникам не нужно ничего записывать вручную. Время, пробег, заказы — всё фиксируется само.' },
  { icon: '💰', title: 'Контроль наличных', desc: 'Логист видит, кто сколько должен, напоминает и подтверждает сдачу. Никаких «я забыл» и «мне не сказали».' },
  { icon: '📊', title: 'Google Таблицы', desc: 'Все данные попадают в таблицы, к которым у руководителя есть доступ. Можно открыть в любой момент и посмотреть.' },
  { icon: '🏆', title: 'Мотивация', desc: 'Рейтинг и уведомления о рекордах — соревновательный элемент, который повышает вовлечённость.' },
  { icon: '📷', title: 'Фото подтверждения', desc: 'Каждое фото пробега, маршрутника и сверки уходит в отдельный чат. Всегда можно перепроверить.' },
  { icon: '🔄', title: 'Два уровня контроля', desc: 'Наличные не списываются автоматически — логист подтверждает каждую сдачу. Исключены ошибки и злоупотребления.' }
];

const requirements = [
  'Телефон с установленным Telegram',
  'Telegram-группа (создаётся за 2 минуты) для общих уведомлений и фото',
  'Таблица Google Sheets со списком сотрудников и их ФИО',
  'Интернет на телефоне (мобильный или Wi-Fi)'
];

// ─────────────────────────────────────────────────────
// 1. HTML — красивая страница
// ─────────────────────────────────────────────────────

function buildHTML() {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let rolesHTML = '';
  for (const role of roles) {
    let btns = role.buttons.map(b =>
      `<tr><td class="btn">${esc(b.btn)}</td><td>${esc(b.text)}</td></tr>`
    ).join('\n');
    rolesHTML += `
      <div class="role-block">
        <h2>${role.emoji} ${esc(role.name)}</h2>
        <p>${esc(role.desc)}</p>
        <table class="btn-table">
          <thead><tr><th style="width:180px;">Кнопка</th><th>Что делает</th></tr></thead>
          <tbody>${btns}</tbody>
        </table>
      </div>`;
  }

  let procsHTML = '';
  for (const p of processes) {
    let lines = p.dialog.map(d =>
      `<tr><td class="who ${d.who === 'Бот — логисту' || d.who === 'Бот — курьеру' || d.who === 'Бот — в группу' || d.who === 'Бот' ? 'bot' : d.who === 'Курьер' ? 'courier' : d.who === 'Логист' ? 'logist' : ''}">${esc(d.who)}</td><td class="msg">${esc(d.text)}</td></tr>`
    ).join('\n');
    procsHTML += `
      <div class="process">
        <h2>📌 ${esc(p.title)}</h2>
        <p class="story">${esc(p.story)}</p>
        <table class="dialog">
          <thead><tr><th style="width:140px;">Кто</th><th>Сообщение</th></tr></thead>
          <tbody>${lines}</tbody>
        </table>
        <p class="note">💡 ${esc(p.note)}</p>
      </div>`;
  }

  let benefitsHTML = benefits.map(b =>
    `<div class="benefit"><span class="benefit-icon">${b.icon}</span><div><strong>${esc(b.title)}</strong><br>${esc(b.desc)}</div></div>`
  ).join('\n');

  let reqHTML = requirements.map(r => `<li>${esc(r)}</li>`).join('\n');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f0f2f5;color:#1a1a2e;line-height:1.7;padding:20px}
.container{max-width:900px;margin:0 auto}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;border-radius:16px;padding:40px;margin-bottom:30px;text-align:center}
.header h1{font-size:28px;margin-bottom:8px}
.header p{font-size:16px;opacity:.85}
.section{background:#fff;border-radius:12px;padding:30px;margin-bottom:25px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.section h2{font-size:22px;margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #e0e0e0}
.role-block{margin-bottom:30px}
.role-block:last-child{margin-bottom:0}
.role-block h2{font-size:20px}
.role-block p{margin-bottom:12px;color:#555}
table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{text-align:left;padding:10px 14px;border:1px solid #e0e0e0;vertical-align:top}
th{background:#f8f9fa;font-weight:600;font-size:14px}
.btn{font-weight:600;white-space:nowrap}
.process{margin-bottom:35px}
.process:last-child{margin-bottom:0}
.story{background:#eef6ff;padding:12px 16px;border-radius:8px;margin-bottom:12px;color:#1a1a2e}
.dialog td.who{font-weight:600;white-space:nowrap;background:#fafafa}
.dialog td.who.bot{color:#2563eb}
.dialog td.who.courier{color:#16a34a}
.dialog td.who.logist{color:#d97706}
.dialog td.msg{white-space:pre-line;font-size:14px}
.note{background:#fef9e7;padding:12px 16px;border-radius:8px;margin-top:12px;color:#5a4a00;font-size:14px}
.benefits-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.benefit{background:#f8f9fa;border-radius:10px;padding:16px;display:flex;gap:14px;align-items:flex-start}
.benefit-icon{font-size:28px;flex-shrink:0}
.benefit strong{font-size:15px}
.benefit div{font-size:14px;color:#555}
.req-list{padding-left:20px;margin:12px 0}
.req-list li{margin-bottom:8px}
.footer{text-align:center;color:#888;font-size:13px;padding:20px}
@media(max-width:600px){.benefits-grid{grid-template-columns:1fr}.container{padding:0}.header{padding:24px 16px}.section{padding:20px 16px}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>📋 ${TITLE}</h1>
    <p>${SUBTITLE}</p>
    <p style="margin-top:6px;font-size:14px;opacity:.7">${DATE}</p>
  </div>

  <div class="section">
    <h2>👥 Кто пользуется ботом</h2>
    ${rolesHTML}
  </div>

  <div class="section">
    <h2>⚙️ Как это работает — примеры</h2>
    <p style="margin-bottom:16px">Ниже — реальные диалоги, которые происходят в Telegram. Именно так бот выглядит для сотрудников.</p>
    ${procsHTML}
  </div>

  <div class="section">
    <h2>✅ Что даёт внедрение</h2>
    <div class="benefits-grid">
      ${benefitsHTML}
    </div>
  </div>

  <div class="section">
    <h2>📱 Что нужно для работы</h2>
    <ul class="req-list">
      ${reqHTML}
    </ul>
  </div>

  <div class="footer">
    ${TITLE} — ${DATE}
  </div>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────
// 2. Word (.docx) — через docx
// ─────────────────────────────────────────────────────

async function buildDocx() {
  const docx = require('docx');
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType, TableLayoutType, convertInchesToTwip, LevelFormat, NumberFormat } = docx;

  // Цвета
  const BLUE = '2563EB';
  const DARK = '1A1A2E';
  const GRAY = '666666';

  // Вспомогательные функции
  const p = (text, opts = {}) => {
    const runs = [];
    if (typeof text === 'string') {
      runs.push(new TextRun({ text, size: 22, font: 'Calibri', color: DARK, ...opts }));
    } else if (Array.isArray(text)) {
      for (const t of text) {
        if (typeof t === 'string') runs.push(new TextRun({ text: t, size: 22, font: 'Calibri', color: DARK }));
        else runs.push(new TextRun({ text: t.text, size: t.size || 22, font: 'Calibri', color: t.color || DARK, bold: t.bold, italics: t.italics }));
      }
    }
    return new Paragraph({ spacing: { after: opts.after || 120, before: opts.before || 0 }, alignment: opts.alignment, children: runs });
  };

  const heading = (text, level) => new Paragraph({
    text,
    heading: level,
    spacing: { before: 240, after: 120 },
    border: level === HeadingLevel.HEADING_1 ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } } : undefined
  });

  const spacer = (size = 60) => new Paragraph({ spacing: { after: size }, children: [] });

  // Таблица-кнопки
  const makeBtnTable = (rows) => {
    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        new TableCell({ width: { size: 2500, type: WidthType.DXA }, shading: { fill: 'F0F0F0' },
          children: [p('Кнопка', { bold: true })] }),
        new TableCell({ shading: { fill: 'F0F0F0' },
          children: [p('Что делает', { bold: true })] })
      ]
    });
    const dataRows = rows.map(r => new TableRow({
      children: [
        new TableCell({ width: { size: 2500, type: WidthType.DXA },
          children: [p(r.btn, { bold: true })] }),
        new TableCell({
          children: [p(r.text)] })
      ]
    }));
    return new Table({
      rows: [headerRow, ...dataRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        top: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        left: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        right: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }
      }
    });
  };

  // Таблица-диалог
  const makeDialogTable = (rows) => {
    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        new TableCell({ width: { size: 2000, type: WidthType.DXA }, shading: { fill: 'F0F0F0' },
          children: [p('Кто', { bold: true })] }),
        new TableCell({ shading: { fill: 'F0F0F0' },
          children: [p('Сообщение', { bold: true })] })
      ]
    });
    const dataRows = rows.map(r => {
      const whoColor = r.who.includes('Бот') ? BLUE : r.who === 'Курьер' ? '16A34A' : r.who === 'Логист' ? 'D97706' : DARK;
      return new TableRow({
        children: [
          new TableCell({ width: { size: 2000, type: WidthType.DXA },
            children: [p(r.who, { bold: true, color: whoColor })] }),
          new TableCell({
            children: [p(r.text, { size: 20 })] })
        ]
      });
    });
    return new Table({
      rows: [headerRow, ...dataRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        top: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        left: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
        right: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }
      }
    });
  };

  const children = [];

  // Титул
  children.push(spacer(400));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text: '📋 ' + TITLE, size: 48, font: 'Calibri', color: DARK, bold: true })]
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new TextRun({ text: SUBTITLE, size: 26, font: 'Calibri', color: '666666' })]
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 600 },
    children: [new TextRun({ text: DATE, size: 22, font: 'Calibri', color: GRAY })]
  }));

  // 1. О документе
  // 1. Роли
  children.push(heading('👥 Кто пользуется ботом', HeadingLevel.HEADING_1));
  for (const role of roles) {
    children.push(new Paragraph({
      spacing: { before: 200, after: 80 },
      children: [new TextRun({ text: role.emoji + ' ' + role.name, size: 28, font: 'Calibri', color: DARK, bold: true })]
    }));
    children.push(p(role.desc));
    children.push(spacer(60));
    children.push(makeBtnTable(role.buttons));
    children.push(spacer(80));
  }

  // 3. Процессы
  children.push(heading('⚙️ Как это работает — примеры', HeadingLevel.HEADING_1));
  children.push(p('Ниже — реальные диалоги, которые происходят в Telegram. Именно так бот выглядит для сотрудников.'));
  children.push(spacer());

  for (const proc of processes) {
    children.push(heading(proc.title, HeadingLevel.HEADING_2));
    children.push(new Paragraph({
      spacing: { before: 60, after: 120 },
      shading: { fill: 'EEF6FF', type: ShadingType.CLEAR },
      indent: { left: 120, right: 120 },
      children: [new TextRun({ text: proc.story, size: 22, font: 'Calibri', color: DARK, italics: true })]
    }));
    children.push(spacer(60));
    children.push(makeDialogTable(proc.dialog));
    children.push(new Paragraph({
      spacing: { before: 100, after: 200 },
      shading: { fill: 'FEF9E7', type: ShadingType.CLEAR },
      indent: { left: 120, right: 120 },
      children: [new TextRun({ text: '💡 ' + proc.note, size: 20, font: 'Calibri', color: '5A4A00' })]
    }));
  }

  // 4. Выгоды
  children.push(heading('✅ Что даёт внедрение', HeadingLevel.HEADING_1));
  for (const b of benefits) {
    children.push(new Paragraph({
      spacing: { before: 100, after: 60 },
      children: [
        new TextRun({ text: b.icon + ' ' + b.title, size: 24, font: 'Calibri', color: DARK, bold: true }),
        new TextRun({ text: ' — ' + b.desc, size: 22, font: 'Calibri', color: DARK })
      ]
    }));
  }
  children.push(spacer());

  // 5. Требования
  children.push(heading('📱 Что нужно для работы', HeadingLevel.HEADING_1));
  for (const req of requirements) {
    children.push(new Paragraph({
      spacing: { after: 60 },
      numbering: { level: 0 },
      children: [new TextRun({ text: req, size: 22, font: 'Calibri', color: DARK })]
    }));
  }

  // Создаём документ
  const doc = new Document({
    creator: 'Courier Shift Bot',
    title: TITLE,
    description: SUBTITLE,
    styles: {
      default: {
        document: {
          run: { size: 22, font: 'Calibri' },
          paragraph: { spacing: { after: 120 } }
        }
      }
    },
    numbering: {
      config: [{
        reference: 'default',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START
        }]
      }]
    },
    sections: [{
      properties: {
        page: {
          margin: { top: convertInchesToTwip(0.8), bottom: convertInchesToTwip(0.8), left: convertInchesToTwip(1), right: convertInchesToTwip(1) }
        }
      },
      children
    }]
  });

  return await Packer.toBuffer(doc);
}

// ─────────────────────────────────────────────────────
// Генерация
// ─────────────────────────────────────────────────────

const outDir = __dirname;

// HTML
fs.writeFileSync(path.join(outDir, 'Telegram-бот для учёта смен курьеров.html'), buildHTML(), 'utf8');
console.log('✅ HTML создан');

// Word
buildDocx().then(buf => {
  fs.writeFileSync(path.join(outDir, 'Telegram-бот для учёта смен курьеров.docx'), buf);
  console.log('✅ Word (.docx) создан');
}).catch(err => {
  console.error('❌ Ошибка Word:', err.message);
});
