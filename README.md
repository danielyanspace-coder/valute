# Crypto IX — Telegram Mini App wallet

USDT-кошелёк в Telegram Mini App. Архитектура и план: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
backend/   Fastify + TypeScript: курс Rapira, проверка Telegram initData, раздача фронта
frontend/  React + Vite: главный экран, сканер QR
```

## Запуск

```bash
npm install
cp .env.example .env          # TELEGRAM_BOT_TOKEN, RATE_MARKUP_PERCENT
npm run dev                   # backend :8080, frontend :5173 (проксирует /api)
```

Прод: `npm run build && npm start` — бэкенд отдаёт `frontend/dist` на том же порту. В @BotFather укажите HTTPS-адрес как URL Mini App.

Проверки: `npm test`, `npm run typecheck`.

## API

| Метод | Ответ |
|---|---|
| `GET /api/rate` | `{ walletRate, change24hPercent, history[], updatedAt }`: 1 USDT в ₽ (ask Rapira + наценка) |
| `GET /api/market` | цены BTC/ETH/USDT/SOL в USD |
| `GET /api/me` | пользователь Telegram; заголовок `Authorization: tma <initData>` |
