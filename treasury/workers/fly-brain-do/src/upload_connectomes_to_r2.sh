#!/bin/bash
# Upload all 7 connectome artifacts to R2 bucket symbient-token-weights
# Usage: bash upload_connectomes_to_r2.sh

set -e

DATA="/home/terex/fly-data/connectomes"
BUCKET="symbient-token-weights"

CONNECTOMES=(
  "drosophila" "rat" "mouse" "ciona" "macaque_modha" "human" "celegans_male"
)

echo "Uploading 7 connectome artifacts to R2 bucket: $BUCKET"
echo "=================================================="

for cid in "${CONNECTOMES[@]}"; do
  wpath="$DATA/$cid/weights.npz"
  mpath="$DATA/$cid/brain.npz"

  if [ ! -f "$wpath" ] || [ ! -f "$mpath" ]; then
    echo "  SKIP $cid (missing files)"
    continue
  fi

  wkey="$cid/weights.npz"
  mkey="$cid/brain.npz"

  echo "  Uploading $cid: $wkey, $mkey"
  npx wrangler r2 object put "$BUCKET/$wkey" --file="$wpath" --remote 2>&1 | grep -E "uploaded|error|Creating" || true
  npx wrangler r2 object put "$BUCKET/$mkey" --file="$mpath" --remote 2>&1 | grep -E "uploaded|error|Creating" || true
done

echo ""
echo "Upload complete. Listing R2 objects:"
npx wrangler r2 object list "$BUCKET" --remote 2>&1 | tail -40
