#!/usr/bin/env bash
# Pull the latest code, rebuild and restart. The database and .env are not touched.
#   sudo bash /opt/cryptoix/scripts/update.sh
set -euo pipefail
APP_DIR=/opt/cryptoix
APP_USER=cryptoix
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }
sqlite3 /var/lib/cryptoix/wallet.db ".backup '/var/backups/cryptoix/wallet-before-update-$(date +%F-%H%M).db'" || true
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && git pull --ff-only && npm ci --no-audit --no-fund && npm run build"
systemctl restart cryptoix
sleep 3
systemctl --no-pager --lines=5 status cryptoix
