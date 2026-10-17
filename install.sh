#!/bin/sh
# Installs (or updates) huntawayd and starts it as a user service.
#
#   curl -fsSL https://github.com/noahGms/huntaway/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --pair        # then shows the pairing QR code
#
# Options:      --pair         show the pairing QR code at the end
#               --no-service   install the binary only
# Environment:  HUNTAWAY_BASE_URL  where the binaries are (default: latest GitHub release)
#               HUNTAWAY_BIN_DIR   install directory (default: ~/.local/bin)
set -eu

BASE_URL="${HUNTAWAY_BASE_URL:-https://github.com/noahGms/huntaway/releases/latest/download}"
BIN_DIR="${HUNTAWAY_BIN_DIR:-$HOME/.local/bin}"
PAIR=0
SERVICE=1
for arg in "$@"; do
  case "$arg" in
    --pair) PAIR=1 ;;
    --no-service) SERVICE=0 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'erreur : %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "système non pris en charge : $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "architecture non prise en charge : $(uname -m)" ;;
esac
asset="huntawayd-$os-$arch"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  fail "curl ou wget est nécessaire"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "→ téléchargement de $asset"
fetch "$BASE_URL/$asset" "$tmp/huntawayd" || fail "téléchargement impossible : $BASE_URL/$asset"
fetch "$BASE_URL/SHA256SUMS" "$tmp/SHA256SUMS" || fail "téléchargement impossible : $BASE_URL/SHA256SUMS"

expected=$(awk -v f="$asset" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "$asset absent de SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/huntawayd" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/huntawayd" | awk '{ print $1 }')
fi
[ "$expected" = "$actual" ] || fail "somme de contrôle incorrecte pour $asset"
say "✓ somme de contrôle vérifiée"

mkdir -p "$BIN_DIR"
install -m 755 "$tmp/huntawayd" "$BIN_DIR/huntawayd"
say "✓ huntawayd installé dans $BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "  (ajoute $BIN_DIR à ton PATH pour lancer huntawayd directement)" ;;
esac
hd="$BIN_DIR/huntawayd"

if ! command -v herdr >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/herdr" ]; then
  say "⚠ Herdr introuvable : installe-le (https://herdr.dev) pour que huntawayd voie tes agents"
fi

if [ "$SERVICE" = 1 ]; then
  if [ "$os" = linux ]; then
    # Over SSH the user bus may not be advertised.
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    # Keep the service running after logout.
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
      loginctl enable-linger "$(id -un)" 2>/dev/null || sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null ||
        say "⚠ lance « sudo loginctl enable-linger $(id -un) » pour garder huntawayd actif après déconnexion"
    fi
  fi
  # Reinstalling restarts it with the new binary.
  "$hd" service install --start
  sleep 2
fi

say
"$hd" status || true

if [ "$PAIR" = 1 ]; then
  say
  "$hd" pair
else
  say
  say "Ensuite : $hd pair   (puis scanne le QR code dans l'app Huntaway)"
fi
