# Courier Mini App (Фаза 1 — курьер)

Telegram Mini App для бота `courier-shift-bot`. React + Vite, тёмная премиум-тема,
анимации (Framer Motion), тосты (sonner), haptics. Каждая функция курьера —
в один-два тапа.

## Экраны

- **Главная** — приветствие, статус смены, плитки действий. «Время» и «Наличные»
  выполняются прямо отсюда в один тап.
- **Пробег** — фото одометра → авто-OCR → подтверждение.
- **Маршрутник** / **Сверка** — загрузка фото и отправка.
- **Профиль** — магазин/устройство/машина с авто-сохранением.

## Локальный запуск

```bash
cd webapp
npm install
cp .env.example .env        # пропишите VITE_API_BASE
npm run dev
```

Вне Telegram (в обычном браузере) авторизация идёт через dev-байпас: на бэкенде
включите `API_ALLOW_DEV_AUTH=1`, а во фронте задайте `VITE_DEV_USER_ID=<telegramId>`.
В Telegram это не нужно — используется подпись `initData`.

## Сборка

```bash
npm run build      # -> webapp/dist
```

## Быстрый сетап на сервере (одна команда)

Если бот и nginx уже на одном сервере — фронт, nginx, `.env` и рестарт бота
делает один скрипт (запускать на сервере под root из корня репозитория):

```bash
bash scripts/setup-miniapp.sh app.example.com      # ваш домен
```

После него остаётся только поднять Cloudflare Tunnel на `http://127.0.0.1:80`
(нужен вход в ваш аккаунт Cloudflare — это нельзя автоматизировать). Подробности
скрипт печатает в конце. Ручной путь — ниже.

## Деплой (рекомендуемый путь)

**1. Backend API (на сервере бота)** — уже встроен в процесс бота
(`api/server.js`, стартует из `bot.js`). Слушает `127.0.0.1:API_PORT`.
Выставляем наружу по HTTPS через Cloudflare Tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create courier-api
# в конфиге туннеля: service: http://127.0.0.1:8080
cloudflared tunnel route dns courier-api courier-api.example.com
cloudflared tunnel run courier-api        # держать под systemd
```

В `.env` бота:
```
API_PORT=8080
MINI_APP_ORIGIN=https://<домен-фронта>
MINI_APP_URL=https://<домен-фронта>
```

**2. Frontend** — статическая сборка `dist/` на любом HTTPS-хостинге
(Vercel / Netlify / Cloudflare Pages). Переменная окружения сборки:
```
VITE_API_BASE=https://courier-api.example.com/api
```

**3. Привязка в Telegram** — после установки `MINI_APP_URL` бот сам ставит
кнопку-меню «Открыть приложение» (`setChatMenuButton`) и кнопку `🚀 Приложение`
в меню курьера. Дополнительно URL можно указать в @BotFather → Bot Settings →
Menu Button.
