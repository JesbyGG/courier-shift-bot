const { Markup } = require('telegraf');
const { WORKPLACES, DEVICES, BUTTONS, WORKPLACE_FEATURES } = require('../config');
const {
  getUserField,
  getUserRole,
  getActiveRemindersForCourier,
  getSelfClearanceRequest,
  isSheetAccessUser
} = require('../services/storage');
const { isAdminUser } = require('../services/auth');

function courierMainMenu(telegramId) {
  const courierType = getUserField(telegramId, 'courierType') || 'auto';
  const rows = [
    [BUTTONS.punchTime]
  ];
  if (courierType !== 'pedestrian') {
    rows.push([BUTTONS.mileage]);
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
    [BUTTONS.punchTime, BUTTONS.openShop]
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
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function mileageConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷 Загрузить фото повторно', 'retry_mileage_photo')],
    [Markup.button.callback('✏️ Ввести вручную', 'edit_mileage')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function mileageSavedKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить пробег', 'edit_mileage')],
    [Markup.button.callback('🏠 В меню', 'back_to_menu')]
  ]);
}

function routeSheetKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Завершить', 'route_sheet_done'),
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function manualMileageKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷 Загрузить фото повторно', 'retry_mileage_photo')],
    [
      Markup.button.callback('⏭️ Пропустить', 'skip_mileage'),
      Markup.button.callback('🏠 В меню', 'back_to_menu')
    ]
  ]);
}

function replaceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Изменить начало', 'replace_start')],
    [Markup.button.callback('🔴 Изменить конец', 'replace_end')],
    [Markup.button.callback('❌ Отмена', 'back_to_menu')]
  ]);
}

function timeChangeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить время', 'edit_time')],
    [Markup.button.callback('🏠 В меню', 'back_to_menu')]
  ]);
}

function mileageReplaceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Изменить пробег начала', 'replace_mileage_start')],
    [Markup.button.callback('🔴 Изменить пробег конца', 'replace_mileage_end')],
    [Markup.button.callback('❌ Отмена', 'back_to_menu')]
  ]);
}

function switchUserKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, сменить', 'confirm_switch_user')],
    [Markup.button.callback('❌ Отмена', 'back_to_menu')]
  ]);
}

function cashSubmitConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, сдал', 'cash_submit_yes')],
    [Markup.button.callback('❌ Нет, не сдал', 'cash_submit_no')],
    [Markup.button.callback('🏠 В меню', 'back_to_menu')]
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
  buttons.push([Markup.button.callback('🏠 В меню', 'back_to_menu')]);
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
