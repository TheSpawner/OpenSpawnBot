#!/bin/bash
set -uo pipefail

APP_DIR="/opt/OpenSpawn Bot"

say()  { printf '\033[1m[OpenSpawn Bot]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[OpenSpawn Bot]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[OpenSpawn Bot]\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" != "0" ]; then
  fail "This installer needs root. Run it with: sudo $0"
fi

if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Status}' openspawn-bot 2>/dev/null | grep -q "install ok installed"; then
  fail "OpenSpawn Bot is already installed through your package manager. Remove it first: sudo apt purge openspawn-bot"
fi
if command -v pacman >/dev/null 2>&1 && pacman -Qq openspawn-bot >/dev/null 2>&1; then
  fail "OpenSpawn Bot is already installed through pacman. Remove it first: sudo pacman -Rns openspawn-bot"
fi

command -v tar >/dev/null 2>&1 || fail "This installer needs tar, which is not installed."

PAYLOAD_LINE="$(awk '/^__OPENSPAWN_BOT_PAYLOAD__$/ { print NR + 1; exit 0 }' "$0")"
[ -n "$PAYLOAD_LINE" ] || fail "This installer is damaged: no payload marker found."

if [ -d "$APP_DIR" ]; then
  say "Replacing the version already in $APP_DIR"
  pkill -TERM -f "$APP_DIR/openspawn-bot" >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$APP_DIR"
fi

say "Installing OpenSpawn Bot to $APP_DIR"
mkdir -p /opt /usr/bin /usr/share/applications
WORK="$(mktemp -d /opt/.openspawn-bot-install.XXXXXX)" || fail "Could not create a folder in /opt."
trap 'rm -rf "$WORK"' EXIT
tail -n +"$PAYLOAD_LINE" "$0" | tar xzf - -C "$WORK" --no-same-owner 2>/dev/null || fail "Could not unpack the application files."
[ -d "$WORK/opt/OpenSpawn Bot" ] || fail "This installer is damaged: the application files are missing."
mv "$WORK/opt/OpenSpawn Bot" "$APP_DIR" || fail "Could not move the application into $APP_DIR."
install -m 644 "$WORK/usr/share/applications/openspawn-bot.desktop" /usr/share/applications/openspawn-bot.desktop
install -m 755 "$WORK/usr/bin/openspawn-bot-uninstall" /usr/bin/openspawn-bot-uninstall
ln -sfn "$APP_DIR/openspawn-bot" /usr/bin/openspawn-bot

INSTALL_STEPS="$APP_DIR/resources/linux/after-install.sh"
[ -f "$INSTALL_STEPS" ] || fail "This installer is damaged: $INSTALL_STEPS is missing."
bash "$INSTALL_STEPS" || warn "Some install steps did not finish."

package_command() {
  if   command -v pacman       >/dev/null 2>&1; then echo "pacman -S --needed --noconfirm"
  elif command -v dnf          >/dev/null 2>&1; then echo "dnf install -y"
  elif command -v zypper       >/dev/null 2>&1; then echo "zypper --non-interactive install"
  elif command -v xbps-install >/dev/null 2>&1; then echo "xbps-install -Sy"
  elif command -v apt-get      >/dev/null 2>&1; then echo "apt-get install -y"
  fi
}

offer_packages() {
  reason="$1"
  shift
  missing=""
  for package in "$@"; do missing="$missing $package"; done
  [ -n "$missing" ] || return 0
  installer="$(package_command)"
  echo
  warn "$reason:$missing"
  if [ -n "$installer" ] && [ -t 0 ]; then
    printf '\033[1m[OpenSpawn Bot]\033[0m Install them now? [Y/n] '
    read -r reply
    case "$reply" in
      ""|y|Y|yes|Yes|YES)
        say "Running: $installer$missing"
        if $installer$missing; then say "Installed."; return 0; fi
        warn "That did not finish."
        ;;
    esac
  fi
  if [ -n "$installer" ]; then
    say "Run this when convenient: sudo $installer$missing"
  else
    say "Install these with your package manager:$missing"
  fi
}

needed=()
command -v python3 >/dev/null 2>&1 || needed+=(python3)
[ "${#needed[@]}" -eq 0 ] || offer_packages "OpenSpawn Bot uses python3 to control the desktop, and it is not installed" "${needed[@]}"

compositor=""
case "${XDG_CURRENT_DESKTOP-}" in
  *Hyprland*|*hyprland*) compositor="hyprland" ;;
  *sway*|*Sway*)         compositor="sway" ;;
esac
if [ -z "$compositor" ]; then
  if pgrep -x Hyprland >/dev/null 2>&1; then compositor="hyprland"
  elif pgrep -x sway >/dev/null 2>&1; then compositor="sway"
  fi
fi
if [ -n "$compositor" ]; then
  needed=()
  command -v wtype >/dev/null 2>&1 || needed+=(wtype)
  command -v grim  >/dev/null 2>&1 || needed+=(grim)
  [ "${#needed[@]}" -eq 0 ] || offer_packages "On $compositor, OpenSpawn Bot needs these to type and take screenshots" "${needed[@]}"
fi

echo
say "OpenSpawn Bot is installed. Open it from your applications menu, or run: openspawn-bot"
say "The first start downloads its engine, model and search engine, about 1 GB, once."
say "To remove it later, run: sudo openspawn-bot-uninstall"
exit 0
__OPENSPAWN_BOT_PAYLOAD__
