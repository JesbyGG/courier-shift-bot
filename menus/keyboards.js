const { Markup } = require('telegraf');
const { WORKPLACES, DEVICES, BUTTONS, WORKPLACE_FEATURES } = require('../config');
const {
  getUserField,
  getUserRole,
  getActiveRemindersForCourier,
  getSelfClearanceRequest,
  isSheetAccessUser,
  getShiftStatus
} = require('../services/storage');
const { isAdminUser } = require('../services/auth');

function getTimeButtonLabel(telegramId) {
  const status = getShiftStatus(telegramId, 'time');
  if (status === 'none') return BUTTONS.punchTimeStart;
  if (status === 'start') return BUTTONS.punchTimeEnd;
  return BUTTONS.punchTimeReplace;
}

function getMileageButtonLabel(telegramId) {
  const status = getShiftStatus(telegramId, 'mileage');
  if (status === 'none') return BUTTONS.mileageStart;
  if (status === 'start') return BUTTONS.mileageEnd;
  return BUTTONS.mileageReplace;
}

function isTimeButton(text) {
  return [
    BUTTONS.punchTime,
    BUTTONS.punchTimeStart,
    BUTTONS.punchTimeEnd,
    BUTTONS.punchTimeReplace
  ].includes(text);
}

function isMileageButton(text) {
  return [
    BUTTONS.mileage,
    BUTTONS.mileageStart,
    BUTTONS.mileageEnd,
    BUTTONS.mileageReplace
  ].includes(text);
}

function courierMainMenu(telegramId) {
  const courierType = getUserField(telegramId, 'courierType') || 'auto';
  const rows = [
    [getTimeButtonLabel(telegramId)]
  ];
  if (courierType !== 'pedestrian') {
    rows.push([getMileageButtonLabel(telegramId)]);
  }
  rows.push([BUTTONS.routeSheet, BUTTONS.reconciliation]);
  rows.push([BUTTONS.cashCheck, BUTTONS.issues]);
  rows.push([BUTTONS.leaderBoard, BUTTONS.settings]);
  return Markup.keyboard(rows).resize();
}

function profileMenu(telegramId) {
  const courierType = getUserField(telegramId, 'courierType') || 'auto';
  const rows = [];
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
  rows.push([BUTTONS.sheetInfo, BUTTONS.settings]);
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

function roleChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👤 Курьер', 'role_courier')],
    [Markup.button.callback('📦 Логист', 'role_logist')]
  ]);
}

function skipMileageKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Ввести вручную', 'edit_mileage')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('❌ Закрыть', 'close_message')
    ]
  ]);
}

function mileageConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷 Загрузить фото повторно', 'retry_mileage_photo')],
    [Markup.button.callback('✏️ Ввести вручную', 'edit_mileage')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('❌ Закрыть', 'close_message')
    ]
  ]);
}

function mileageSavedKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить пробег', 'edit_mileage')],
    [Markup.button.callback('❌ Закрыть', 'close_message')]
  ]);
}

function routeSheetKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Завершить', 'route_sheet_done'),
      Markup.button.callback('❌ Закрыть', 'close_message')
    ]
  ]);
}

function manualMileageKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷 Загрузить фото повторно', 'retry_mileage_photo')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('❌ Закрыть', 'close_message')
    ]
  ]);
}

function replaceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Изменить начало', 'replace_start')],
    [Markup.button.callback('🔴 Изменить конец', 'replace_end')],
    [Markup.button.callback('❌ Отмена', 'close_message')]
  ]);
}

function timeChangeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить время', 'edit_time')],
    [Markup.button.callback('❌ Закрыть', 'close_message')]
  ]);
}

function mileageReplaceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Изменить пробег начала', 'replace_mileage_start')],
    [Markup.button.callback('🔴 Изменить пробег конца', 'replace_mileage_end')],
    [Markup.button.callback('❌ Отмена', 'close_message')]
  ]);
}

function switchUserKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, сменить', 'confirm_switch_user')],
    [Markup.button.callback('❌ Отмена', 'close_message')]
  ]);
}

function cashSubmitConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, сдал', 'cash_submit_yes')],
    [Markup.button.callback('❌ Нет, не сдал', 'cash_submit_no')],
    [Markup.button.callback('❌ Закрыть', 'close_message')]
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
    buttons.push([Markup.button.callback(label, `d_${debtor.telegramId}`)]);
  }
  if (buttons.length === 0) {
    return null;
  }
  buttons.push([Markup.button.callback('❌ Закрыть', 'close_message')]);
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
  getTimeButtonLabel,
  getMileageButtonLabel,
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
