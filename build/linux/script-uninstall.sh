#!/bin/bash
set -o pipefail

APP_DIR="/opt/OpenSpawn Bot"
REMOVE_STEPS="$APP_DIR/resources/linux/after-remove.sh"

RED=""
BOLD=""
PLAIN=""
if [ -t 1 ]; then
  RED="$(printf '\033[31m')"
  BOLD="$(printf '\033[1m')"
  PLAIN="$(printf '\033[0m')"
fi

usage() {
  echo "Usage: sudo openspawn-bot-uninstall [--purge]"
  echo "  no flag   remove the app, its engine, model and search engine; keep chats and settings"
  echo "  --purge   also delete chats and settings"
}

MODE=""
case "${1:-}" in
  "") ;;
  --purge) MODE="purge" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac

if [ "$(id -u)" != "0" ]; then
  echo "This uninstaller needs root. Run it with: sudo openspawn-bot-uninstall${MODE:+ --purge}" >&2
  exit 1
fi

if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Status}' openspawn-bot 2>/dev/null | grep -q "install ok installed"; then
  if [ "$MODE" = "purge" ]; then exec apt-get purge -y openspawn-bot; fi
  exec apt-get remove -y openspawn-bot
fi

if [ ! -d "$APP_DIR" ]; then
  echo "OpenSpawn Bot is not installed at $APP_DIR. Nothing to do."
  rm -f /usr/bin/openspawn-bot-uninstall
  exit 0
fi

TARGET_HOME="$HOME"
if [ -n "$SUDO_USER" ]; then
  TARGET_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
fi
DATA="$TARGET_HOME/.local/share/openspawn-bot"

size_of() { if [ -d "$1" ]; then du -sh "$1" 2>/dev/null | cut -f1; else echo "-"; fi; }

confirm_purge() {
  if [ ! -t 0 ]; then
    echo "Deleting chats and settings needs confirmation. Run this in a terminal: sudo openspawn-bot-uninstall --purge" >&2
    exit 1
  fi
  printf '\n%sThis permanently deletes every chat and setting of OpenSpawn Bot%s\n' "$RED" "$PLAIN"
  printf '%sfor every account on this machine. It cannot be undone.%s\n\n' "$RED" "$PLAIN"
  printf 'Type DELETE to confirm: '
  read -r confirmation
  if [ "$confirmation" != "DELETE" ]; then
    echo "Not confirmed. Nothing was removed."
    exit 1
  fi
}

printf '\n%sOpenSpawn Bot uninstaller%s\n\n' "$BOLD" "$PLAIN"
echo "On this account:"
printf '  %-52s %s\n' "$DATA" "$(size_of "$DATA")"
printf '  %-52s %s\n' "$DATA/runtime" "$(size_of "$DATA/runtime")"
echo

if [ "$MODE" = "purge" ]; then
  confirm_purge
elif [ -t 0 ]; then
  echo "  1) Remove the app, its engine, model and search engine. Keep my chats and settings."
  printf '  2) %sRemove everything.%s Also deletes my chats and settings.\n' "$RED" "$PLAIN"
  echo "  3) Cancel."
  echo
  printf 'Choose [1/2/3]: '
  read -r choice
  case "$choice" in
    1) MODE="remove" ;;
    2) confirm_purge; MODE="purge" ;;
    *) echo "Cancelled. Nothing was removed."; exit 0 ;;
  esac
else
  MODE="remove"
fi

echo
if [ -f "$REMOVE_STEPS" ]; then
  STEPS="$(mktemp)"
  cp "$REMOVE_STEPS" "$STEPS"
  bash "$STEPS" "$MODE"
  rm -f "$STEPS"
fi

rm -rf "$APP_DIR"
rm -f /usr/share/applications/openspawn-bot.desktop /usr/bin/openspawn-bot
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true

if [ "$MODE" != "purge" ]; then
  echo "To delete your chats and settings too, run: sudo openspawn-bot-uninstall --purge"
fi

rm -f /usr/bin/openspawn-bot-uninstall
exit 0
