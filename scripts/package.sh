#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -e "process.stdout.write(require('$ROOT_DIR/manifest.json').version)")
OUT_DIR="$ROOT_DIR/dist"
OUT_FILE="$OUT_DIR/meerkat-$VERSION.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

cd "$ROOT_DIR"
zip -r "$OUT_FILE" manifest.json src assets/icons -x "*.DS_Store" > /dev/null

echo "$OUT_FILE"
