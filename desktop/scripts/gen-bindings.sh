#!/bin/sh
# Regenerates src/api/generated/ from the Rust types of huntaway-api (ts-rs).
# JSON numbers are plain numbers: ts-rs maps u64 to bigint, so rewrite it.
set -e
cd "$(dirname "$0")/.."
out="$PWD/src/api/generated"
rm -rf "$out"
(cd ../bridge && TS_RS_EXPORT_DIR="$out" cargo test -q -p huntaway-api --features ts export_bindings >/dev/null)
find "$out" -name '*.ts' -exec sed -i.bak 's/bigint/number/g' {} \;
find "$out" -name '*.bak' -delete
echo "types generated in src/api/generated/"
