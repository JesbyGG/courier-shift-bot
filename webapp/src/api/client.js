import { getInitData, getUser } from "../telegram";

const BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/+$/, "");

// Сообщения об ошибках от бэкенда -> человекочитаемый русский текст.
const ERROR_TEXT = {
  not_registered:
    "Профиль не найден. Сначала пройдите регистрацию в боте (/start).",
  no_sheet: "На этот месяц ещё не привязана таблица. Сообщите администратору.",
  courier_not_found: "Вас нет в таблице курьеров. Сообщите администратору.",
  invalid_stage: "Не удалось определить этап. Обновите приложение.",
  invalid_mileage: "Неверный пробег — введите от 2 до 6 цифр.",
  invalid_car: "Неверный номер машины.",
  invalid_workplace: "Неизвестный магазин.",
  invalid_device: "Неизвестное устройство.",
  no_photo: "Не получено фото.",
  no_photos: "Добавьте хотя бы одно фото.",
  forward_failed: "Не удалось отправить фото. Попробуйте ещё раз.",
  expired: "Сессия устарела. Перезапустите приложение.",
  bad_hash: "Ошибка авторизации. Перезапустите приложение.",
};

export function humanError(code) {
  return ERROR_TEXT[code] || "Что-то пошло не так. Попробуйте ещё раз.";
}

function authHeaders() {
  const headers = {};
  const initData = getInitData();
  if (initData) {
    headers["Authorization"] = `tma ${initData}`;
  } else {
    // Dev-режим вне Telegram (требует API_ALLOW_DEV_AUTH=1 на бэкенде).
    const devId = import.meta.env.VITE_DEV_USER_ID;
    const user = getUser();
    if (devId) headers["X-Dev-User-Id"] = String(devId);
    else if (user?.id) headers["X-Dev-User-Id"] = String(user.id);
  }
  return headers;
}

async function parse(res) {
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const code = data?.error || `http_${res.status}`;
    const err = new Error(code);
    err.code = code;
    err.data = data;
    throw err;
  }
  return data;
}

export async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  return parse(res);
}

export async function apiSend(path, body, method = "POST") {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parse(res);
}

export async function apiUpload(path, files, fieldName = "photos") {
  const form = new FormData();
  const list = Array.isArray(files) ? files : [files];
  for (const file of list) {
    if (file) form.append(fieldName, file);
  }
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  return parse(res);
}
