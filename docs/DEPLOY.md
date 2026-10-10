# Установка Crypto IX на сервер

Сервер: Ubuntu 24.04 или 26.04, от 1 ядра и 2 ГБ памяти. Домен (или адрес DuckDNS) должен указывать на IP сервера записью `A`.

## 1. Установка одной командой

От root на сервере:

```bash
git clone https://github.com/danielyanspace-coder/valute.git /opt/cryptoix
bash /opt/cryptoix/scripts/server-setup.sh cryptoix.duckdns.org cryptoixwallet_bot cryptoix 8602356502
```

Аргументы: домен, username бота, username поддержки, Telegram ID администратора.

Скрипт (`scripts/server-setup.sh`) можно запускать повторно, он ничего не ломает:
- ставит Node.js 24, Caddy (HTTPS выпускается сам), sqlite3, файл подкачки 2 ГБ;
- собирает проект в `/opt/cryptoix` от отдельного пользователя `cryptoix`;
- создаёт `/opt/cryptoix/.env` (права 600) со случайным паролем админки `ADMIN_TOKEN`;
- запускает службу `cryptoix` (systemd, перезапуск при сбое и после перезагрузки);
- открывает в файрволе только 22, 80, 443;
- каждую ночь копирует базу в `/var/backups/cryptoix`, хранит 14 дней.

База данных: `/var/lib/cryptoix/wallet.db`.

## 2. Секреты (вписывает владелец сам, никуда не пересылая)

```bash
nano /opt/cryptoix/.env
```

- `TELEGRAM_BOT_TOKEN=`: новый токен из BotFather (`/revoke` → выбрать бота). Старый токен после этого перестанет работать.
- `TRONGRID_API_KEY=`: ключ из trongrid.io.

Сохранить: `Ctrl+O`, `Enter`, выйти: `Ctrl+X`. Затем:

```bash
systemctl restart cryptoix
journalctl -u cryptoix -n 30 --no-pager
```

В логе должно быть `Server listening` и без ошибок про бота.

## 3. BotFather

- `/mybots` → бот → **Bot Settings** → **Configure Mini App** → **Enable Mini App** → URL `https://<домен>`.
- `/mybots` → бот → **Bot Settings** → **Menu Button** → URL `https://<домен>`, название `Кошелёк`.

## 4. Админка

`https://<домен>/admin`, пароль: `ADMIN_TOKEN` из `.env` (`grep ADMIN_TOKEN /opt/cryptoix/.env`).

Первым делом: **Пополнения → Адреса** → добавить 10 адресов TronLink, основной кошелёк с галочкой «Это мой кошелёк».

## 5. Проверка перед запуском для всех

1. Открыть бота, нажать «Кошелёк», приложение открывается, курс виден.
2. Пополнить на 1-2 USDT, зачисление через 1-2 минуты.
3. Вывести USDT на свой второй кошелёк, отметить отправку хэшем в админке.
4. Вывод на карту на минимальную сумму, пройти сделку до конца.
5. Чек через `@cryptoixwallet_bot 1` в любом чате.

## Обновление

```bash
bash /opt/cryptoix/scripts/update.sh
```

Перед обновлением база копируется в `/var/backups/cryptoix`, `.env` и данные не трогаются.

## Полезные команды

| Что | Команда |
|---|---|
| Статус | `systemctl status cryptoix` |
| Логи вживую | `journalctl -u cryptoix -f` |
| Перезапуск | `systemctl restart cryptoix` |
| Логи HTTPS | `journalctl -u caddy -n 50 --no-pager` |
| Копии базы | `ls -lh /var/backups/cryptoix` |

Копии базы лежат на том же сервере. Раз в неделю скачивайте свежую копию к себе (например, WinSCP), чтобы не потерять балансы, если сервер умрёт.

## Анимированные эмодзи в сообщениях бота

Все сообщения бота уже с обычными эмодзи и жирным шрифтом. Анимированные (как у Crypto Bot) Telegram разрешает ботам только с коллекционным username с Fragment.

1. Купить username на fragment.com (оплата TON) и привязать его к боту в разделе управления username на Fragment.
2. Найти или сделать пак эмодзи (@Stickers → `/newemojipack`, анимации .tgs или .webm 100×100).
3. Со своего Telegram (`ADMIN_TELEGRAM_ID`) отправить боту нужные эмодзи. Бот ответит их ID.
4. В `/opt/cryptoix/.env`:
   ```
   CUSTOM_EMOJI=on
   CUSTOM_EMOJI_IDS=deposit=ID,received=ID,success=ID,cancel=ID,check=ID,warning=ID,clock=ID
   ```
   Ключи: deposit (пополнение), received (пришли деньги), withdraw, success, cancel, pending, clock, warning, check (чек), usdt, lock, unlock, support, hold (удержание), rocket (приветствие), gift.
5. `systemctl restart cryptoix`. Эмодзи без ID остаются обычными.
