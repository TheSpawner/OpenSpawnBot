#!/bin/bash
set -uo pipefail

APP_DIR="/opt/OpenSpawn Bot"

log() { printf '\033[1m[OpenSpawn Bot]\033[0m %s\n' "$*"; }

SANDBOX="$APP_DIR/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" && chmod 4755 "$SANDBOX" || true
fi

ln -sfn "$APP_DIR/openspawn-bot" /usr/bin/openspawn-bot

ICONS="$APP_DIR/resources/linux/icons"
if [ -d "$ICONS" ]; then
  for icon in "$ICONS"/*x*.png; do
    [ -f "$icon" ] || continue
    size="$(basename "$icon" .png)"
    mkdir -p "/usr/share/icons/hicolor/$size/apps"
    cp "$icon" "/usr/share/icons/hicolor/$size/apps/openspawn-bot.png"
  done
fi

update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache --force --quiet /usr/share/icons/hicolor >/dev/null 2>&1 || true

log "Installation complete"
exit 0
