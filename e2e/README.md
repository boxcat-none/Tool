# e2e 測試

用真的瀏覽器（Playwright + Chromium）和真的軟體版（Tauri + WebDriver）操作整個 app。單元測試在各 package 的 `test/`（`pnpm test`）。

```bash
pnpm e2e                         # 網頁版全部（建置 → 啟動 preview :4173 → 17 組，約 15 分鐘）
SKIP_BUILD=1 bash e2e/run-web.sh lasso images   # 只跑某幾組、不重新建置
pnpm e2e:desktop                 # 軟體版（Linux；需要 xvfb-run、tauri-driver、WebKitWebDriver）
```

每組輸出 `PASS …`／`FAIL …`，log 在 `e2e/.out/logs/<組名>.log`，截圖與下載的檔案在 `e2e/.out/`（不進 git）。

## 前置

- Playwright：`require("playwright")` 要能載入，且已安裝 Chromium（`npx playwright install chromium`）。
- 300 頁的壓力測試 PDF 太大不放 repo，`run-web.sh` 會先執行 `node e2e/make-stress-pdf.cjs` 產生。
- 路徑都從 `e2e/lib/env.cjs` 取；新測試也照這樣寫，不要寫死絕對路徑。

## 各組

| 組 | 內容 |
|---|---|
| `run` `run2` `run3` | PDF 工具：合併、分割、整理頁面、圖片轉 PDF、PDF 轉圖片 |
| `reader` `reader2` | 閱讀器：中文字型、目錄、搜尋、密碼、連結、縮放 |
| `ink` | 手寫：鋼筆、螢光筆、橡皮擦、復原 |
| `notes` | 書櫃、插頁、移動／刪除頁、`.guganote`、匯出、有密碼的 PDF |
| `ipad` `ipad-images` | iPad 模擬（CDP 觸控＋觸控筆）：不反白、兩指縮放、只用觸控筆、拖曳圖片與套索 |
| `offline` | 加入主畫面（manifest）、Service Worker、離線開啟與書寫 |
| `memory` `stress` | 300 頁大檔：記憶體上限、各操作耗時（`stress` 是量測，不在預設清單） |
| `sync` `sync-big` `sync-live` | 裝置連線（WebRTC）：配對、同步、斷線、合併、大檔傳輸、即時筆畫 |
| `images` `rotate` `lasso` | 插入圖片、旋轉、套索選取 |
| `iphone-shots` | iPhone 尺寸截圖（人工看，不在預設清單） |
| `desktop*` | 軟體版：Office 轉 PDF、原生存檔對話框（`VITE_E2E=1` 建置時由 `window.__e2e` 提供結果）、自動儲存 |

## 寫測試時要知道的事

- 中文檔名：上傳用 `{ name, mimeType, buffer }`（多個非 ASCII 路徑會被 Playwright 丟掉）；下載要 `LANG=C.UTF-8`。
- 圖片、筆跡層都是 `pointer-events: none`，`elementsFromPoint` 找不到；要驗證疊放順序用截圖取色。
- 同步太快：要量「對方移動前的位置」時，先量再操作。
- 這個容器裡 WebRTC 配對約 80 次會逾時 1 次（mDNS），重跑即可；連續失敗才是問題。
- 只有本機能連的網路：公開的配對伺服器、STUN 都連不到，測試只走本機。
