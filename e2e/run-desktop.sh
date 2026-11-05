#!/usr/bin/env bash
# 軟體版（Tauri）e2e：VITE_E2E=1 建置除錯版 → xvfb 裡啟動 tauri-driver → 依序執行
# 需要：Rust、Tauri 系統套件、xvfb-run、WebKitWebDriver、`cargo install tauri-driver`；Office 測試需要 LibreOffice
set -uo pipefail
cd "$(dirname "$0")/.."
export LANG=C.UTF-8 LC_ALL=C.UTF-8
OUT=e2e/.out; mkdir -p "$OUT/logs"
SUITES=(desktop-sync desktop desktop-reader2 desktop-ink desktop-notes)
[ $# -gt 0 ] && SUITES=("$@")

if [ "${SKIP_BUILD:-}" != 1 ]; then
  (cd apps/desktop && VITE_E2E=1 npx tauri build --debug --no-bundle) >"$OUT/logs/tauri-build.log" 2>&1 || { echo "建置失敗 → $OUT/logs/tauri-build.log"; exit 1; }
fi
DRIVER="${TAURI_DRIVER:-$(command -v tauri-driver || echo ~/.cargo/bin/tauri-driver)}"
LIST="${SUITES[*]}"
xvfb-run -a -s "-screen 0 1280x900x24" bash -c "
  '$DRIVER' >'$OUT/logs/tauri-driver.log' 2>&1 &
  for _ in \$(seq 1 30); do curl -s http://127.0.0.1:4444/status >/dev/null && break; sleep 0.5; done
  for s in $LIST; do node e2e/\$s.cjs >'$OUT/logs/'\$s.log 2>&1; done
  kill %1"
total=0; failed=0
for s in "${SUITES[@]}"; do
  log="$OUT/logs/$s.log"; pass=$(grep -c '^PASS' "$log"); fail=$(grep -cE '^FAIL|^ERROR' "$log")
  total=$((total + pass))
  if [ "$fail" -gt 0 ]; then failed=$((failed + 1)); echo "✗ $s：$pass 通過、$fail 失敗 → $log"; else echo "✓ $s：$pass 通過"; fi
done
echo "共 $total 項通過；$failed 組有失敗"
exit $(( failed > 0 ))
