#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/3] deno check"
deno check supabase/functions/ocr/index.ts supabase/functions/ocr/core.ts

echo "[2/3] deno lint"
deno lint supabase/functions/ocr/index.ts supabase/functions/ocr/core.ts supabase/functions/ocr/_shared/*.ts

echo "[3/3] deno test"
DENO_TESTING=1 deno test -A --no-check supabase/functions/ocr/tests/ocr.test.ts
