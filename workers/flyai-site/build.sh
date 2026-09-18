#!/usr/bin/env bash
# Assemble workers/flyai-site/public from site/ statics + the built flybook SPA.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SITE="$ROOT/site"
OUT="$(dirname "$0")/public"

cd "$SITE/flybook"
pnpm install --frozen-lockfile
pnpm build

rm -rf "$OUT"
mkdir -p "$OUT/flybook"
for f in "$SITE"/*; do
  base=$(basename "$f")
  [ "$base" = flybook ] && continue
  cp -r "$f" "$OUT/"
done
cp -r "$SITE/flybook/dist/"* "$OUT/flybook/"
echo "built -> $OUT"
