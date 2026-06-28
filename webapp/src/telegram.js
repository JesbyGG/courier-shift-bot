// Обёртка над Telegram WebApp SDK с безопасными заглушками для запуска
// в обычном браузере (разработка вне Telegram).

const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : null;

export function getTg() {
  return tg;
}

export function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    // Тёмная «премиум» шапка/фон под наш дизайн.
    tg.setHeaderColor?.("#0b0b14");
    tg.setBackgroundColor?.("#0b0b14");
    tg.enableClosingConfirmation?.();
  } catch (_) {
    /* noop */
  }
}

// initData для авторизации на бэкенде. В dev (вне Telegram) — пусто,
// тогда используется dev-байпас (X-Dev-User-Id) при настроенном API_ALLOW_DEV_AUTH.
export function getInitData() {
  return tg?.initData || "";
}

export function getUser() {
  return tg?.initDataUnsafe?.user || null;
}

const HAPTIC_STYLES = ["light", "medium", "heavy", "rigid", "soft"];

export function haptic(kind = "light") {
  if (!tg?.HapticFeedback) return;
  try {
    if (kind === "success" || kind === "error" || kind === "warning") {
      tg.HapticFeedback.notificationOccurred(kind);
    } else if (kind === "select") {
      tg.HapticFeedback.selectionChanged();
    } else if (HAPTIC_STYLES.includes(kind)) {
      tg.HapticFeedback.impactOccurred(kind);
    }
  } catch (_) {
    /* noop */
  }
}

export function showBackButton(handler) {
  if (!tg?.BackButton) return () => {};
  try {
    tg.BackButton.show();
    tg.BackButton.onClick(handler);
  } catch (_) {
    /* noop */
  }
  return () => {
    try {
      tg.BackButton.offClick(handler);
      tg.BackButton.hide();
    } catch (_) {
      /* noop */
    }
  };
}

// Нативное подтверждение Telegram (Promise<boolean>).
export function confirmPopup(message) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) {
      tg.showConfirm(message, (ok) => resolve(Boolean(ok)));
    } else {
      resolve(window.confirm(message));
    }
  });
}
