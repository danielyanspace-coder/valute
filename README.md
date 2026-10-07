# Crypto IX - Telegram Mini App wallet

USDT-кошелёк в Telegram Mini App. Архитектура и план: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
backend/   Fastify + TypeScript: курс Rapira, проверка Telegram initData, раздача фронта
frontend/  React + Vite: главный экран, сканер QR
```

## Запуск

```bash
npm install
cp .env.example .env          # TELEGRAM_BOT_TOKEN, WEBAPP_URL, ADMIN_TOKEN, курсы
npm run dev                   # backend :8080, frontend :5173 (проксирует /api)
```

Прод: `npm run build && npm start` - бэкенд отдаёт `frontend/dist` на том же порту. В @BotFather укажите HTTPS-адрес как URL Mini App.

Проверки: `npm test`, `npm run typecheck`.

Демо без бэкенда и Telegram: `npm run demo` → `demo/crypto-ix-demo.html` (курсы Rapira на момент сборки).

## API

| Метод | Ответ |
|---|---|
| `GET /api/rate` | `{ walletRate, qrPayRate, change24hPercent, history[], updatedAt }`: курс кошелька (ask Rapira + 5%, по нему же вывод) и курс оплаты QR СБП (bid Rapira - 5%), ₽ за 1 USDT |
| `GET /api/market` | цены BTC/ETH/USDT/SOL в USD |
| `GET /api/me` | пользователь Telegram; заголовок `Authorization: tma <initData>` |
| `GET /api/admin/aml/check?chain=TRON&address=…` | бесплатная AML-проверка адреса; `Authorization: Bearer $ADMIN_TOKEN` |
| `POST /api/withdrawals` | заявка на вывод в рубли (СБП или карта), USDT замораживаются |
| `POST /api/withdrawals/:id/received` · `/not-received` · `/other-amount` | ответы пользователя по сделке: оплата поступила / не поступила / другая сумма |
| `GET /api/notifications` | уведомления для окон в приложении |
| `/admin` | админка: сделки, архив, пользователи, теневые заморозки, журнал, рассылки, МК, пополнения; пароль `ADMIN_TOKEN` |
| `/api/admin/deals/*` · `/users/*` · `/obligations` · `/journal` · `/broadcasts` | API админки, `Authorization: Bearer $ADMIN_TOKEN` |
| `POST /api/transfers` | перевод по username, без комиссии |
| `POST /api/checks` · `GET /api/checks` · `POST /api/checks/:id/cancel` | чеки |
| `GET /api/history` | история: выводы, переводы, чеки, заявки МК, пополнения, удержания |
| `GET /api/checks/image/:amount.jpg` | картинка чека для бота |
