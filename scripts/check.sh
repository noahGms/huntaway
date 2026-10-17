#!/usr/bin/env bash
# Runs every check of the repo: Rust tests + clippy, Flutter analyze + tests.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== bridge"
(cd bridge && cargo test --quiet && cargo clippy --all-targets --quiet -- -D warnings)

echo "== app"
(cd app && flutter analyze && flutter test)

echo "✓ tout est vert"
