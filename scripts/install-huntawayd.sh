#!/usr/bin/env bash
# Builds huntawayd, installs it in ~/.local/bin and starts it as a user service.
# Usage: scripts/install-huntawayd.sh [--no-service]
set -euo pipefail
cd "$(dirname "$0")/../bridge"

cargo build --release -p huntawayd
mkdir -p "$HOME/.local/bin"
install -m 755 target/release/huntawayd "$HOME/.local/bin/huntawayd"
echo "✓ huntawayd installed in ~/.local/bin"

if [[ "${1:-}" != "--no-service" ]]; then
  "$HOME/.local/bin/huntawayd" service install --start
  sleep 2  # let the service bind its ports before checking
fi

"$HOME/.local/bin/huntawayd" status
echo
echo "Next: huntawayd pair   (then scan the QR code with the app)"
