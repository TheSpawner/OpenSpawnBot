#!/bin/bash
set -uo pipefail

ACTION="remove"
if [ "$#" -ge 1 ]; then ACTION="$1"; fi
case "$ACTION" in remove|purge) ;; *) exit 0 ;; esac

APP_DIR="/opt/OpenSpawn Bot"
DATA_LEAF=".local/share/openspawn-bot"
WORK_LEAF="Documents/OpenSpawn Bot"

log() { printf '\033[1m[OpenSpawn Bot]\033[0m %s\n' "$*"; }

stop_all() {
  pkill "-$1" -f "$APP_DIR/openspawn-bot" >/dev/null 2>&1
  pkill "-$1" -f "/openspawn-bot/runtime/" >/dev/null 2>&1
  pkill "-$1" -f "/openspawn-bot/browser-profiles" >/dev/null 2>&1
}
stop_all TERM
sleep 2
stop_all KILL

[ -L /usr/bin/openspawn-bot ] && rm -f /usr/bin/openspawn-bot
rm -f /usr/share/icons/hicolor/*/apps/openspawn-bot.png
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache --force --quiet /usr/share/icons/hicolor >/dev/null 2>&1 || true

homes() {
  while IFS=: read -r _name _password uid _gid _gecos home _shell; do
    case "$uid" in ''|*[!0-9]*) continue ;; esac
    [ "$uid" -ge 1000 ] || continue
    [ "$uid" -lt 65534 ] || continue
    [ -d "$home" ] && echo "$home"
  done < /etc/passwd
  echo /root
}

kept_work=()
while IFS= read -r home; do
  data="$home/$DATA_LEAF"
  case "$data" in /*/.local/share/openspawn-bot) ;; *) continue ;; esac
  if [ "$ACTION" = "purge" ]; then
    if [ -d "$data" ]; then
      log "Removing $data"
      rm -rf "$data"
    fi
  elif [ -d "$data/runtime" ]; then
    log "Removing the engine, model and search engine in $data/runtime"
    rm -rf "$data/runtime"
  fi
  [ -d "$home/$WORK_LEAF" ] && kept_work+=("$home/$WORK_LEAF")
done < <(homes)

if [ "$ACTION" = "purge" ]; then
  log "OpenSpawn Bot and all of its data have been removed."
else
  log "OpenSpawn Bot was removed. Your chats and settings were kept."
fi
for folder in "${kept_work[@]}"; do
  log "The files OpenSpawn Bot saved for you were kept in $folder"
done
exit 0
