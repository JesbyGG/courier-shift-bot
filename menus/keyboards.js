const { Markup } = require('telegraf');
const { WORKPLACES, DEVICES, BUTTONS, WORKPLACE_FEATURES } = require('../config');
const {
  getUserField,
  getUserRole,
  getActiveRemindersForCourier,
  getSelfClearanceRequest,
  isSheetAccessUser,
  getShiftStatus,
  getPendingCash
} = require('../services/storage');
const { isAdminUser } = require('../services/auth');
const { styledButton, styledReplyButton } = require('../utils');

function getTimeButtonLabel(telegramId) {
  const status = getShiftStatus(telegramId, 'time');
  if (status === 'none') return styledReplyButton(BUTTONS.punchTimeStart, 'success');
  if (status === 'start') return styledReplyButton(BUTTONS.punchTimeEnd, 'danger');
  return styledReplyButton(BUTTONS.punchTimeReplace, 'primary');
}

function getMileageButtonLabel(telegramId) {
  const status = getShiftStatus(telegramId, 'mileage');
  if (status === 'none') return styledReplyButton(BUTTONS.mileageStart, 'success');
  if (status === 'start') return styledReplyButton(BUTTONS.mileageEnd, 'danger');
  return styledReplyButton(BUTTONS.mileageReplace, 'primary');
}

function getButtonText(btn) {
  return typeof btn === 'object' ? btn.text : btn;
}

function isTimeButton(text) {
  const t = getButtonText(text);
  return [
    BUTTONS.punchTime,
    BUTTONS.punchTimeStart,
    BUTTONS.punchTimeEnd,
    BUTTONS.punchTimeReplace
  ].includes(t);
}

function isMileageButton(text) {
  const t = getButtonText(text);
  return [
    BUTTONS.mileage,
    BUTTONS.mileageStart,
    BUTTONS.mileageEnd,
    BUTTONS.mileageReplace
  ].includes(t);
}

function courierMainMenu(telegramId) {
  const courierType = getUserField(telegramId, 'courierType') || 'auto';
  const timeBtn = getTimeButtonLabel(telegramId);
  const mileageBtn = getMileageButtonLabel(telegramId);

  const rows = [];

  // Кнопка запуска Mini App — только если задан MINI_APP_URL.
  // Бот без неё продолжает работать как раньше.
  if (process.env.MINI_APP_URL) {
    rows.push([Markup.button.webApp('🚀 Приложение', process.env.MINI_APP_URL)]);
  }

  if (courierType !== 'pedestrian') {
    rows.push([timeBtn]);
    rows.push([mileageBtn]);
  } else {
    rows.push([timeBtn]);
  }

  rows.push([BUTTONS.routeSheet, BUTTONS.reconciliation]);

  const pendingCash = getPendingCash(telegramId);
  const hasCash = pendingCash && pendingCash.amount > 0 && pendingCash.confirmationStatus !== 'awaiting';
  if (hasCash) {
    const cashText = pendingCash.formatted
      ? `${BUTTONS.cashCheck} ${pendingCash.formatted}`
      : BUTTONS.cashCheck;
    rows.push([styledReplyButton(cashText, 'danger')]);
  }

  rows.push([BUTTONS.issues]);
  return Markup.keyboard(rows).resize();
}

function profileMenu(telegramId) {
  const courierType = getUserField(telegramId, 'courierType') || 'auto';
  const rows = [
    [BUTTONS.profile]
  ];
  if (courierType !== 'pedestrian') {
    rows.push([BUTTONS.changeCar, BUTTONS.changeWorkplace]);
  } else {
    rows.push([BUTTONS.changeWorkplace]);
  }
  rows.push([BUTTONS.changeDevice, BUTTONS.switchUser]);
  rows.push([BUTTONS.backToSettings]);
  return Markup.keyboard(rows).resize();
}

function workplaceMenu() {
  return Markup.keyboard([
    WORKPLACES,
    [BUTTONS.back]
  ]).resize();
}

function deviceMenu() {
  return Markup.keyboard([
    DEVICES,
    [BUTTONS.back]
  ]).resize();
}

function logistMainMenu(telegramId) {
  const workplace = getUserField(telegramId, 'workplace');
  const features = WORKPLACE_FEATURES[workplace] || {};
  const rows = [
    [getTimeButtonLabel(telegramId), BUTTONS.openShop]
  ];
  if (features.cashCollection) {
    rows.push([BUTTONS.cashCollect, BUTTONS.cashHistory]);
  }
  rows.push([BUTTONS.sheetInfo]);
  return Markup.keyboard(rows).resize();
}

function logistSettingsMenu() {
  return Markup.keyboard([
    [BUTTONS.profile],
    [BUTTONS.myId],
    [BUTTONS.help],
    [BUTTONS.back]
  ]).resize();
}

function logistProfileMenu() {
  return Markup.keyboard([
    [BUTTONS.changeWorkplace, BUTTONS.switchUser],
    [BUTTONS.backToSettings]
  ]).resize();
}

function getMenuForRole(telegramId) {
  const role = getUserRole(telegramId);
  if (role === 'logist') {
    return logistMainMenu(telegramId);
  }
  return courierMainMenu(telegramId);
}

function getSettingsMenuForRole(telegramId) {
  const role = getUserRole(telegramId);
  if (role === 'logist') {
    return logistSettingsMenu();
  }
  const showSheets = isAdminUser(telegramId) || isSheetAccessUser(telegramId);
  const buttons = [
    [BUTTONS.profile]
  ];
  if (showSheets) {
    buttons.push([BUTTONS.sheetInfo, BUTTONS.myId]);
  } else {
    buttons.push([BUTTONS.myId]);
  }
  buttons.push([BUTTONS.help]);
  buttons.push([BUTTONS.back]);
  return Markup.keyboard(buttons).resize();
}

function getProfileMenuForRole(telegramId) {
  const role = getUserRole(telegramId);
  if (role === 'logist') {
    return logistProfileMenu();
  }
  return profileMenu(telegramId);
}

// ─── Inline настройки (callback-based, без засорения чата) ───

function settingsInlineKeyboard(telegramId) {
  const role = getUserRole(telegramId);
  if (role === 'logist') {
    return Markup.inlineKeyboard([
      [styledButton(BUTTONS.profile, 'cfg_profile', 'primary')],
      [styledButton(BUTTONS.myId, 'cfg_my_id')],
      [styledButton(BUTTONS.help, 'cfg_help')],
      [styledButton('❌ Закрыть', 'cfg_back_to_menu', 'danger')]
    ]);
  }
  const showSheets = isAdminUser(telegramId) || isSheetAccessUser(telegramId);
  const rows = [
    [styledButton(BUTTONS.profile, 'cfg_profile', 'primary')]
  ];
  if (showSheets) {
    rows.push([styledButton(BUTTONS.sheetInfo, 'cfg_sheet_info'), styledButton(BUTTONS.myId, 'cfg_my_id')]);
  } else {
    rows.push([styledButton(BUTTONS.myId, 'cfg_my_id')]);
  }
  rows.push([styledButton(BUTTONS.help, 'cfg_help')]);
  rows.push([styledButton('❌ Закрыть', 'cfg_back_to_menu', 'danger')]);
  return Markup.inlineKeyboard(rows);
}

function profileInlineKeyboard(telegramId) {
  const role = getUserRole(telegramId);
  if (role === 'logist') {
    return Markup.inlineKeyboard([
      [styledButton(BUTTONS.changeWorkplace, 'cfg_workplace')],
      [styledButton(BUTTONS.switchUser, 'cfg_switch_user')],
      [styledButton('◀️ К настройкам', 'cfg_back_to_settings')]
    ]);
  }
  const courierType = getUserField(telegramId, 'courierType') || 'auto';
  const rows = [];
  if (courierType !== 'pedestrian') {
    rows.push([styledButton(BUTTONS.changeCar, 'cfg_car'), styledButton(BUTTONS.changeWorkplace, 'cfg_workplace')]);
  } else {
    rows.push([styledButton(BUTTONS.changeWorkplace, 'cfg_workplace')]);
  }
  rows.push([styledButton(BUTTONS.changeDevice, 'cfg_device'), styledButton(BUTTONS.switchUser, 'cfg_switch_user')]);
  rows.push([styledButton('◀️ К настройкам', 'cfg_back_to_settings')]);
  return Markup.inlineKeyboard(rows);
}

function roleChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('👤 Курьер', 'role_courier', 'primary')],
    [styledButton('📦 Логист', 'role_logist', 'primary')]
  ]);
}

function skipMileageKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('✏️ Ввести вручную', 'edit_mileage', 'primary')],
    [
      styledButton('⏭️ Пропустить', 'skip_mileage'),
      styledButton('❌ Закрыть', 'close_message', 'danger')
    ]
  ]);
}

function mileageConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('📷 Загрузить фото повторно', 'retry_mileage_photo', 'primary')],
    [styledButton('✏️ Ввести вручную', 'edit_mileage', 'primary')],
    [
      styledButton('⏭️ Пропустить', 'skip_mileage'),
      styledButton('❌ Закрыть', 'close_message', 'danger')
    ]
  ]);
}

function mileageSavedKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('✏️ Изменить пробег', 'edit_mileage', 'primary')],
    [styledButton('❌ Закрыть', 'close_message', 'danger')]
  ]);
}

function routeSheetKeyboard() {
  return Markup.inlineKeyboard([
    [
      styledButton('✅ Завершить', 'route_sheet_done', 'success'),
      styledButton('❌ Закрыть', 'close_message', 'danger')
    ]
  ]);
}

function manualMileageKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('📷 Загрузить фото повторно', 'retry_mileage_photo', 'primary')],
    [
      styledButton('⏭️ Пропустить', 'skip_mileage'),
      styledButton('❌ Закрыть', 'close_message', 'danger')
    ]
  ]);
}

function replaceKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('🟢 Изменить начало', 'replace_start', 'success')],
    [styledButton('🔴 Изменить конец', 'replace_end', 'danger')],
    [styledButton('❌ Отмена', 'close_message', 'danger')]
  ]);
}

function timeChangeKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('✏️ Изменить время', 'edit_time', 'primary')],
    [styledButton('❌ Закрыть', 'close_message', 'danger')]
  ]);
}

function mileageReplaceKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('🟢 Изменить пробег начала', 'replace_mileage_start', 'success')],
    [styledButton('🔴 Изменить пробег конца', 'replace_mileage_end', 'danger')],
    [styledButton('❌ Отмена', 'close_message', 'danger')]
  ]);
}

function switchUserKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('✅ Да, сменить', 'confirm_switch_user', 'success')],
    [styledButton('❌ Отмена', 'close_message', 'danger')]
  ]);
}

function cashSubmitConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [styledButton('✅ Да, сдал', 'cash_submit_yes', 'success')],
    [styledButton('❌ Нет, не сдал', 'cash_submit_no', 'danger')],
    [styledButton('❌ Закрыть', 'close_message', 'danger')]
  ]);
}

function debtorListKeyboard(debtors, logistWorkplace) {
  const buttons = [];
  for (const debtor of debtors) {
    const activeReminders = getActiveRemindersForCourier(debtor.telegramId);
    let label = `👤 ${debtor.fio} — ${debtor.formatted || debtor.amount} ₽`;
    if (activeReminders.length > 0) {
      const remindedBy = activeReminders.map(r => r.logistFio).join(', ');
      label += ` 🔔(${remindedBy})`;
    }
    const selfClearance = getSelfClearanceRequest(debtor.telegramId);
    if (selfClearance) {
      label = `👤 ${debtor.fio} — ${selfClearance.formatted || selfClearance.amount} ₽ ⏳`;
    }
    buttons.push([styledButton(label, `d_${debtor.telegramId}`)]);
  }
  if (buttons.length === 0) {
    return null;
  }
  buttons.push([styledButton('❌ Закрыть', 'close_message', 'danger')]);
  return Markup.inlineKeyboard(buttons);
}

module.exports = {
  courierMainMenu,
  profileMenu,
  workplaceMenu,
  deviceMenu,
  logistMainMenu,
  logistSettingsMenu,
  logistProfileMenu,
  getMenuForRole,
  getSettingsMenuForRole,
  getProfileMenuForRole,
  settingsInlineKeyboard,
  profileInlineKeyboard,
  getTimeButtonLabel,
  getMileageButtonLabel,
  getButtonText,
  isTimeButton,
  isMileageButton,
  roleChoiceKeyboard,
  skipMileageKeyboard,
  mileageConfirmKeyboard,
  mileageSavedKeyboard,
  routeSheetKeyboard,
  manualMileageKeyboard,
  replaceKeyboard,
  timeChangeKeyboard,
  mileageReplaceKeyboard,
  switchUserKeyboard,
  cashSubmitConfirmKeyboard,
  debtorListKeyboard
};
