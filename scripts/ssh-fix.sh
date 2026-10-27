#!/usr/bin/env bash
# SSH does not let you in: diagnose and repair from the Aeza web console (no copy-paste there).
#   bash /opt/cryptoix/scripts/ssh-fix.sh
# Safe to run again. Keeps port 22 and adds 2222 as a spare.
set -u
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
ok() { printf '  \033[1;32m✔ %s\033[0m\n' "$1"; }
bad() { printf '  \033[1;31m✘ %s\033[0m\n' "$1"; }

SPARE=2222
CONF=/etc/ssh/sshd_config.d/10-cryptoix.conf

say "1. Состояние до исправления"
systemctl is-active --quiet ssh && ok "служба ssh запущена" || bad "служба ssh не запущена"
ss -tln | grep -qE ':22\s' && ok "порт 22 слушается" || bad "порт 22 никто не слушает"
ufw status 2>/dev/null | grep -qE '^(22|OpenSSH)' && ok "ufw пропускает 22" || bad "ufw не пропускает 22"

say "2. Второй порт SSH $SPARE"
mkdir -p /etc/ssh/sshd_config.d
grep -q '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
printf 'Port 22\nPort %s\n' "$SPARE" > "$CONF"
if sshd -t 2>/tmp/sshd-test.txt; then
  ok "конфиг sshd в порядке"
else
  bad "конфиг sshd с ошибкой, откатываю:"; cat /tmp/sshd-test.txt; rm -f "$CONF"
fi

say "3. Файрвол ufw"
ufw allow 22/tcp >/dev/null
ufw allow "$SPARE"/tcp >/dev/null
ufw reload >/dev/null && ok "открыты 22 и $SPARE"

say "4. fail2ban: мягче и без банов"
if command -v fail2ban-client >/dev/null; then
  printf '[sshd]\nenabled = true\nport = 22,%s\nmaxretry = 8\nfindtime = 10m\nbantime = 15m\n' "$SPARE" > /etc/fail2ban/jail.d/cryptoix.local
  systemctl restart fail2ban
  sleep 2
  fail2ban-client unban --all >/dev/null 2>&1
  ok "8 попыток, бан 15 минут, баны сняты"
fi

say "5. Перезапуск SSH"
systemctl daemon-reload
# Ubuntu 24.04+ starts sshd from ssh.socket: its ports come from sshd_config via a generator.
systemctl is-enabled --quiet ssh.socket 2>/dev/null && systemctl restart ssh.socket
systemctl enable ssh >/dev/null 2>&1
systemctl restart ssh
sleep 1
ss -tln | grep -qE ':22\s' && ok "слушается 22" || bad "22 не слушается"
ss -tln | grep -qE ":$SPARE\s" && ok "слушается $SPARE" || bad "$SPARE не слушается"

say "6. Доходят ли пакеты до сервера"
command -v tcpdump >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y tcpdump >/dev/null 2>&1
LOG=/tmp/ssh-probe.txt
printf '\n\033[1;33m   СЕЙЧАС ПОПРОБУЙТЕ ПОДКЛЮЧИТЬСЯ С КОМПЬЮТЕРА:\n   ssh root@2.56.175.147\n   (жду 60 секунд)\033[0m\n'
timeout 60 tcpdump -ni any -l "tcp and (dst port 22 or dst port $SPARE or src port 22 or src port $SPARE) and not host 127.0.0.1" >"$LOG" 2>/dev/null
IN=$(grep -cE '> [0-9.]+\.(22|'"$SPARE"'): Flags \[S\]' "$LOG")
OUT=$(grep -cE '\.(22|'"$SPARE"') > [0-9.]+: Flags \[S\.\]' "$LOG")

say "ИТОГ"
if [ "$IN" -eq 0 ]; then
  bad "Попытки подключения НЕ доходят до сервера."
  echo "  Блокирует не сервер, а сеть до него: Aeza или провайдер."
  echo "  Напишите в поддержку Aeza: «входящие соединения на порт 22 не доходят до VPS 2.56.175.147»."
  echo "  И попробуйте с другой сети: ssh -p $SPARE root@2.56.175.147"
elif [ "$OUT" -eq 0 ]; then
  bad "Пакеты доходят ($IN), но сервер не отвечает. Пришлите фото этого экрана."
else
  ok "Пакеты доходят ($IN), сервер отвечает ($OUT). Подключение должно работать."
fi
echo
echo "  Подключение: ssh root@2.56.175.147   или   ssh -p $SPARE root@2.56.175.147"
