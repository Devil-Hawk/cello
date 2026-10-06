#!/bin/sh
# Run one output eval: sh scripts/evals/outputs/run.sh outreach --label after [--quick] [--out DIR]
# Bundles the script with esbuild (the repo has no tsx), resolving "@/" like tsconfig does.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
WEB=$(cd "$HERE/../../.." && pwd)
ROOT=$(cd "$WEB/../.." && pwd)
NAME=$1
shift
ESBUILD=$(ls -d "$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -n 1)
OUT="$WEB/.cache/evals-outputs/bundle-$NAME.mjs"
mkdir -p "$WEB/.cache/evals-outputs"
nice -n 19 "$ESBUILD" "$HERE/$NAME.ts" --bundle --platform=node --format=esm --packages=external \
  --alias:@="$WEB" --alias:@cello/shared="$ROOT/packages/shared/src" \
  --outfile="$OUT" --log-level=warning
cd "$WEB"
exec nice -n 19 node "$OUT" "$@"
