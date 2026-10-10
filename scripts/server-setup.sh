#!/usr/bin/env bash
# One-shot server setup for Crypto IX on Ubuntu 24.04 / 26.04. Safe to run again.
#
#   sudo bash scripts/server-setup.sh <domain> [bot_username] [support_username] [admin_telegram_id]
#   sudo bash scripts/server-setup.sh cryptoix.duckdns.org cryptoixwallet_bot cryptoix 8602356502
#
# Installs Node.js, Caddy (automatic HTTPS), builds the app into /opt/cryptoix, runs it as a
# systemd service under its own user, opens only ports 22/80/443 and backs the database up daily.
# Secrets (bot token, TronGrid key) are NOT passed here: put them into /opt/cryptoix/.env yourself.
set -euo pipefail

DOMAIN="${1:?usage: server-setup.sh <domain> [bot_username] [support_username] [admin_telegram_id]}"
BOT_USERNAME="${2:-}"
SUPPORT_USERNAME="${3:-}"
ADMIN_TELEGRAM_ID="${4:-}"
REPO="${REPO:-https://github.com/danielyanspace-coder/valute.git}"
APP_DIR=/opt/cryptoix
DATA_DIR=/var/lib/cryptoix
BACKUP_DIR=/var/backups/cryptoix
APP_USER=cryptoix
PORT=8080

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates gnupg sqlite3 ufw openssl fail2ban unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

step "Security updates installed automatically, SSH password guessing banned"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
cat > /etc/fail2ban/jail.d/cryptoix.local <<'JAIL'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
JAIL
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || true

step "Swap (builds need more than 2 GB of memory)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Node.js 24 LTS"
node_ok() { node -v 2>/dev/null | grep -Eq '^v(2[2-9]|[3-9][0-9])\.'; }
if ! node_ok; then
  # NodeSource first; if it does not support this Ubuntu release yet, Ubuntu's own package.
  if curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; then
    apt-get install -y nodejs
  else
    apt-get install -y nodejs npm
  fi
fi
node_ok || { echo "Node.js 22+ is required, got $(node -v 2>/dev/null || echo none)"; exit 1; }
node -v; npm -v

step "Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

step "App user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR" "$BACKUP_DIR"
chmod 700 "$DATA_DIR" "$BACKUP_DIR"

step "Code"
if [ -d "$APP_DIR/.git" ]; then
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Build (a few minutes on a small server)"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run build"

step "Settings (.env)"
ENV="$APP_DIR/.env"
if [ ! -f "$ENV" ]; then
  cp "$APP_DIR/.env.example" "$ENV"
  setv() { sed -i "s|^$1=.*|$1=$2|" "$ENV"; grep -q "^$1=" "$ENV" || echo "$1=$2" >> "$ENV"; }
  setv PORT "$PORT"
  setv HOST 127.0.0.1
  setv ALLOW_DEV_AUTH false
  setv ADMIN_TOKEN "$(openssl rand -hex 24)"
  setv WEBAPP_URL "https://$DOMAIN"
  setv DATABASE_PATH "$DATA_DIR/wallet.db"
  [ -n "$BOT_USERNAME" ] && setv BOT_USERNAME "${BOT_USERNAME#@}"
  [ -n "$SUPPORT_USERNAME" ] && setv SUPPORT_USERNAME "${SUPPORT_USERNAME#@}"
  [ -n "$ADMIN_TELEGRAM_ID" ] && setv ADMIN_TELEGRAM_ID "$ADMIN_TELEGRAM_ID"
  echo "Created $ENV"
else
  echo "$ENV already exists, left as is"
fi
chown "$APP_USER:$APP_USER" "$ENV"
chmod 600 "$ENV"

step "Service"
cat > /etc/systemd/system/cryptoix.service <<UNIT
[Unit]
Description=Crypto IX wallet
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR/backend
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/backend/src/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable cryptoix
systemctl restart cryptoix

step "HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
systemctl reload caddy || systemctl restart caddy

step "Firewall: only SSH, HTTP, HTTPS"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

step "Daily database backup, 14 days kept"
cat > /etc/cron.d/cryptoix-backup <<CRON
SHELL=/bin/bash
20 3 * * * $APP_USER sqlite3 $DATA_DIR/wallet.db ".backup '$BACKUP_DIR/wallet-\$(date +\%F).db'" && find $BACKUP_DIR -name 'wallet-*.db' -mtime +14 -delete
CRON
chmod 644 /etc/cron.d/cryptoix-backup

sleep 3
step "Done"
systemctl --no-pager --lines=0 status cryptoix || true
echo
echo "Admin panel:  https://$DOMAIN/admin"
echo "Admin password (ADMIN_TOKEN): $(grep '^ADMIN_TOKEN=' "$ENV" | cut -d= -f2)"
echo
echo "Next: put TELEGRAM_BOT_TOKEN and TRONGRID_API_KEY into $ENV  (nano $ENV)"
echo "      then: systemctl restart cryptoix"
