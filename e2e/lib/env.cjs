// e2e 測試共用的路徑與設定（所有測試腳本都從這裡取路徑，不寫死絕對路徑）
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_ROOT = process.env.E2E_OUT || path.join(ROOT, "e2e", ".out");

module.exports = {
  ROOT,
  /** 網頁版網址（`pnpm --filter @tool/web preview --port 4173` 啟動的建置版本） */
  BASE: (process.env.E2E_BASE_URL || "http://localhost:4173").replace(/\/$/, ""),
  /** 測試用的 PDF、Office 檔（放在 repo） */
  FIX: path.join(ROOT, "e2e", "fixtures"),
  /** 300 頁／28 MB 的壓力測試 PDF：太大不放 repo，用 `node e2e/make-stress-pdf.cjs` 產生 */
  STRESS_PDF: path.join(OUT_ROOT, "stress", "textbook-300.pdf"),
  /** 輸出資料夾（截圖、下載的檔案）；不進 git */
  out(name) {
    const dir = path.join(OUT_ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  /** 和 app 用同一份 pdf-lib（@cantoo/pdf-lib），在 Node 裡產生／檢查 PDF */
  PDF_LIB: path.join(ROOT, "packages", "core", "node_modules", "pdf-lib"),
  FFLATE: path.join(ROOT, "apps", "web", "node_modules", "fflate"),
  /** 軟體版 e2e：`VITE_E2E=1 npx tauri build --debug --no-bundle` 產生的執行檔 */
  DESKTOP_APP: path.join(ROOT, "apps", "desktop", "src-tauri", "target", "debug", "pdf-toolbox"),
};
