#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -e "process.stdout.write(require('$ROOT_DIR/manifest.json').version)")
OUT_DIR="$ROOT_DIR/dist"
BUILD_DIR="$OUT_DIR/firefox"
OUT_FILE="$OUT_DIR/meerkat-$VERSION-firefox.zip"

rm -rf "$BUILD_DIR"
rm -f "$OUT_FILE"
mkdir -p "$BUILD_DIR/assets"

cp -R "$ROOT_DIR/src" "$BUILD_DIR/src"
cp -R "$ROOT_DIR/assets/icons" "$BUILD_DIR/assets/icons"

ROOT_DIR="$ROOT_DIR" BUILD_DIR="$BUILD_DIR" node <<'NODE'
const fs = require("fs");
const path = require("path");

const rootDir = process.env.ROOT_DIR;
const buildDir = process.env.BUILD_DIR;
const manifestPath = path.join(rootDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

manifest.background = {
  scripts: ["src/background.js"]
};
manifest.browser_specific_settings = {
  gecko: {
    id: "meerkat@chenyukang.github.io",
    strict_min_version: "121.0"
  }
};

fs.writeFileSync(
  path.join(buildDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
NODE

cd "$BUILD_DIR"
zip -r "$OUT_FILE" manifest.json src assets/icons -x "*.DS_Store" > /dev/null

echo "$OUT_FILE"
