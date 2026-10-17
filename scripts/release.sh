#!/usr/bin/env bash
# Builds release binaries of huntawayd into dist/, with the names install.sh
# downloads, plus install.sh itself and SHA256SUMS:
#   dist/huntawayd-macos-arm64
#   dist/huntawayd-linux-x86_64, dist/huntawayd-linux-arm64   (static, via cargo-zigbuild)
# Optional: --apk also builds the Android APK.
# CI does the same on a `v*` tag (.github/workflows/release.yml).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist

(cd bridge && cargo build --release -p huntawayd)
cp bridge/target/release/huntawayd "dist/huntawayd-macos-$(uname -m | sed 's/aarch64/arm64/')"

for target in x86_64:x86_64-unknown-linux-musl arm64:aarch64-unknown-linux-musl; do
  (cd bridge && cargo zigbuild --release -p huntawayd --target "${target#*:}")
  cp "bridge/target/${target#*:}/release/huntawayd" "dist/huntawayd-linux-${target%%:*}"
done

if [[ "${1:-}" == "--apk" ]]; then
  (cd app && flutter build apk --release --target-platform android-arm64)
  cp app/build/app/outputs/flutter-apk/app-release.apk dist/huntaway-android-arm64.apk
fi

cp install.sh dist/
(cd dist && shasum -a 256 huntaway* > SHA256SUMS)
ls -lh dist
