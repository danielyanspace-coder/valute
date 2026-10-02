# Crypto IX — Telegram Mini App wallet

USDT-кошелёк в Telegram Mini App. Архитектура и план: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
backend/   Fastify + TypeScript: курс Rapira, проверка Telegram initData, раздача фронта
frontend/  React + Vite: главный экран, сканер QR
```

## Запуск

```bash
npm install
cp .env.example .env          # TELEGRAM_BOT_TOKEN, RATE_BUY_MARKUP_PERCENT, RATE_SELL_DISCOUNT_PERCENT
npm run dev                   # backend :8080, frontend :5173 (проксирует /api)
```

Прод: `npm run build && npm start` — бэкенд отдаёт `frontend/dist` на том же порту. В @BotFather укажите HTTPS-адрес как URL Mini App.

Проверки: `npm test`, `npm run typecheck`.

Демо без бэкенда и Telegram: `npm run demo` → `demo/crypto-ix-demo.html` (курсы Rapira на момент сборки).

## API

| Метод | Ответ |
|---|---|
| `GET /api/rate` | `{ buyRate, sellRate, change24hPercent, history[], updatedAt }`: покупка (ask Rapira + 5%) и оплата СБП (bid Rapira − 5%), ₽ за 1 USDT |
| `GET /api/market` | цены BTC/ETH/USDT/SOL в USD |
| `GET /api/me` | пользователь Telegram; заголовок `Authorization: tma <initData>` |
| `GET /api/admin/aml/check?chain=TRON&address=…` | бесплатная AML-проверка адреса; `Authorization: Bearer $ADMIN_TOKEN` |
