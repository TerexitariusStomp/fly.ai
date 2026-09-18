#!/usr/bin/env bash
# Assemble workers/flyai-site/public from site/ statics + the built flybook SPA.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SITE="$ROOT/site"
OUT="$(cd "$(dirname "$0")" && pwd)/public"

mkdir -p "$SITE/flybook/public"
find "$SITE/flybook/public" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp "$SITE/assets/logo.webp" "$SITE/flybook/public/logo.webp"

cd "$SITE/flybook"
pnpm install --frozen-lockfile
pnpm build

cd "$ROOT/frontend"
pnpm install --frozen-lockfile
VITE_BASE_PATH=/app/ pnpm build

rm -rf "$OUT"
mkdir -p "$OUT/flybook" "$OUT/app"
for f in "$SITE"/*; do
  base=$(basename "$f")
  [ "$base" = flybook ] && continue
  cp -r "$f" "$OUT/"
done
rm -rf "$OUT/world/server"
cp -r "$SITE/flybook/dist/"* "$OUT/flybook/"
cp -r "$ROOT/frontend/dist/"* "$OUT/app/"
find "$OUT/app" -name '*.map' -delete
echo "built -> $OUT"
