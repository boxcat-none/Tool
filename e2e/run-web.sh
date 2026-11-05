#!/usr/bin/env bash
# 網頁版 e2e：建置 → 啟動 preview（4173）→ 依序執行各組測試 → 統計
# 用法：bash e2e/run-web.sh [組名…]   例：bash e2e/run-web.sh lasso images
# 環境變數：SKIP_BUILD=1 不重新建置；E2E_BASE_URL 指定其他網址（就不啟動 preview）
set -uo pipefail
cd "$(dirname "$0")/.."
export LANG=C.UTF-8 LC_ALL=C.UTF-8 # 中文檔名下載時需要
OUT=e2e/.out; mkdir -p "$OUT/logs"

SUITES=(run run2 run3 reader reader2 ink notes ipad offline memory sync sync-big sync-live images ipad-images rotate lasso)
[ $# -gt 0 ] && SUITES=("$@")

[ "${SKIP_BUILD:-}" = 1 ] || pnpm --filter @tool/web build >/dev/null || { echo "建置失敗"; exit 1; }
node e2e/make-stress-pdf.cjs >/dev/null || exit 1

PREVIEW_PID=""
if [ -z "${E2E_BASE_URL:-}" ] && ! curl -sf -o /dev/null http://localhost:4173/; then
  (cd apps/web && exec npx vite preview --port 4173 --strictPort) >"$OUT/logs/preview.log" 2>&1 &
  PREVIEW_PID=$!
  for _ in $(seq 1 40); do curl -sf -o /dev/null http://localhost:4173/ && break; sleep 0.5; done
fi

total=0; failed=0
for s in "${SUITES[@]}"; do
  log="$OUT/logs/$s.log"
  timeout 600 node "e2e/$s.cjs" >"$log" 2>&1; code=$?
  pass=$(grep -c '^PASS' "$log"); fail=$(grep -c '^FAIL' "$log")
  total=$((total + pass))
  if [ $code -ne 0 ] || [ "$fail" -gt 0 ]; then
    failed=$((failed + 1)); echo "✗ $s：$pass 通過、$fail 失敗（exit $code）→ $log"; grep -E '^FAIL|Error' "$log" | head -5 | sed 's/^/    /'
  else
    echo "✓ $s：$pass 通過"
  fi
done
[ -n "$PREVIEW_PID" ] && kill "$PREVIEW_PID" 2>/dev/null
echo "共 $total 項通過；$failed 組有失敗"
exit $(( failed > 0 ))
