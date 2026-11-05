# 交接文件

給接手的 agent。先讀完「工作方式」與「下一步」，其餘章節做到相關部分時再查。

最後更新：2026-11-05，`main` = PR #12 合併後（W13 完成）。

## 專案一句話

PDF 工具箱＋類 GoodNotes 的手寫筆記 app。網頁版（GitHub Pages，可加入主畫面離線使用）與軟體版（Tauri：Windows／macOS／Linux）共用同一份介面；
iPad／iPhone 用網頁版。目標是多台裝置（iPad＋電腦）即時協作同一本筆記本。

- 網址：https://boxcat-none.github.io/Tool/（推到 `main` 自動部署）
- 功能清單與開發指令：`README.md`；已知限制與待辦：`docs/backlog.md`（**單一來源**，新限制一律加在這裡）

## 工作方式（使用者的規則）

1. **用繁體中文**：和使用者對話、介面文字、文件、commit 訊息、PR 標題與內容。
2. **只有使用者說「合併」才合併 PR。** 流程：開分支 `claude/notes-<週次>` → 完成並全部測試通過 → 開 PR → 等 CI 綠燈 → 回報使用者並等「合併」。使用者說「合併後繼續」= 合併這個 PR 再開始下一項。
3. 每個功能都要有：單元測試（`packages/*/test`）＋ e2e（`e2e/`，見 `e2e/README.md`）＋ 文件更新（`docs/backlog.md` 的已完成／新限制、相關設計文件、`docs/ipad-test-checklist.md` 的實機測試項目）。
4. 開 PR 前跑完整回歸：`pnpm typecheck && pnpm test && pnpm e2e && pnpm e2e:desktop`，PR 內容寫實際的測試數字。
5. 回報時把「需要使用者決定的事」和「需要使用者實機測試的事」講清楚；做不到或沒測到的照實說。
6. 使用者用 Windows 電腦和 iPad 實機測試，回報常附截圖；收到問題先重現（e2e 模擬 iPad 觸控／觸控筆），修好後加測試。

## 進度

| 週次 | 內容 | 狀態 |
|---|---|---|
| W0–W5 | PDF 工具、單機筆記（書櫃、手寫、插頁、`.guganote`、匯出、有密碼的 PDF、300 頁效能） | ✅ |
| W6 | iPad：Apple Pencil、兩指縮放、加入主畫面與離線、記憶體 | ✅（**等使用者 iPad 實機測試**，見 `docs/ipad-test-checklist.md`） |
| W7–W8 | 區網連線技術驗證（WebRTC，手動連線碼）、同步協定、即時顯示對方正在畫的筆畫 | ✅ 測試版 |
| W9–W11 | 正式協作：配對方式、斷線自動重連 | ⛔ **等使用者決定 backlog #19** |
| W12–W13 | 插入圖片、圖片旋轉、套索選取、iPhone 版面 | ✅ |
| W14+ | 雲端同步、App Store（選做） | 未開始 |

## 下一步

### A. 卡住的：W9–W11 配對與自動重連（等 backlog #19）

使用者還沒選。兩個選項與比較在 `docs/w7-lan-spike.md` 最後一節：

- **① 配對伺服器（建議）**：6 位數配對碼（或 QR code）交換 WebRTC 連線資訊，筆記內容仍走裝置之間的 WebRTC。
  需要一個很小的伺服器（建議 Cloudflare Workers＋Durable Objects 免費方案，**使用者要自己建帳號、給部署權限**）。
  有了它才能做斷線自動重連（重連需要再交換一次連線資訊）。配對碼要拿來驗證連線資訊，避免伺服器竄改。
- **② 維持手動連線碼**：不用伺服器，但不能自動重連。

使用者選了之後：W9 配對＋自動重連 → W10 多台裝置與書櫃層級同步（目前同步單位是一本筆記本）→ W11 實機測試與修正（macOS 軟體版也在 W11 測）。
不要自行替使用者選，也不要自己去建雲端帳號。

### B. 不受 #19 影響、可以直接做的（依價值排序，開始前先跟使用者確認要做哪個）

1. 處理使用者的實機測試回饋（iPad、Windows）——永遠優先。
2. backlog #20：複製貼上（筆跡、圖片）、圖片上下順序、套索縮放／旋轉筆跡。
3. backlog #14：匯出時設定 PDF 密碼（@cantoo/pdf-lib 已支援加密）。
4. backlog #11：書櫃封面縮圖、排序、搜尋、資料夾。

完成條件：功能＋測試＋文件＋回歸全綠＋PR 開好並回報，等使用者說「合併」。

## 程式地圖

設計細節寫在各自的文件，這裡只列入口：

| 部分 | 位置 | 詳細文件 |
|---|---|---|
| PDF 處理（合併、分割、圖片互轉）、筆跡編碼與 PDF 讀寫 | `packages/core/src/`、`packages/core/src/ink/` | `docs/w1-ink-capacity.md` |
| 筆記本模型（Yjs）、`.guganote`、匯出、圖片、套索批次修改 | `packages/notes/src/notebook.ts` `file.ts` `pdf.ts` | `docs/notes-data-model.md` |
| 裝置同步協定（Yjs 更新、awareness、檔案傳輸） | `packages/notes/src/sync.ts` | `docs/w7-lan-spike.md` |
| 書櫃（IndexedDB）、Worker、pdf.js 載入、平台層（網頁／Tauri） | `apps/web/src/lib/` | `README.md` 的專案結構 |
| 閱讀器、手寫層、圖片層、套索、觸控手勢 | `apps/web/src/reader/`（`NotebookView.tsx` `ink.ts` `images.ts` `gestures.ts`） | 本文件「容易踩的坑」 |
| WebRTC 連線、連線碼、連線中的裝置 | `apps/web/src/sync/` | `docs/w7-lan-spike.md` |
| Service Worker、pdf.js 資源複製 | `apps/web/vite.config.ts`、`apps/web/src/sw-template.js` | — |
| 軟體版（存檔對話框、LibreOffice 轉檔） | `apps/desktop/src-tauri/src/` | `README.md` |
| CI、Pages 部署、安裝檔打包 | `.github/workflows/ci.yml` `desktop.yml` | `README.md` |
| 效能量測 | `packages/notes/bench/`、`e2e/stress.cjs` | `docs/w5-performance.md` |

## 容易踩的坑

讀程式看不出來、但做錯會壞掉的事：

**PDF**
- `pdf-lib` 在 package.json 是 `npm:@cantoo/pdf-lib` 的別名（支援用密碼解密）。測試裡 `require` 和 ESM `import` 混用會載入兩份，`instanceof` 失效：同一個測試只用一種。
- PDF 的 FlateDecode 是 zlib 格式：用 fflate 的 `zlibSync`，不是 `deflateSync`。
- 有密碼的 PDF：密碼只放記憶體；沒給密碼就匯出會產生打不開的檔案，所以 `exportPdf` 直接拋錯。
- pdf.js：`globalThis.pdfjsLib` 要在 import `pdf_viewer.mjs` 之前設好；cMap、標準字型等資源由 Vite 外掛複製到 `dist/pdfjs/`，Service Worker 執行時快取。

**閱讀器**
- 顯示用 PDF 不含筆跡、也不含圖片（各自疊一層畫），所以拖曳、書寫不必重新產生 PDF。**重新產生顯示用 PDF 會換掉所有頁面元素**，進行中的拖曳會中斷：只有原始 PDF 改變時才重新產生（收到圖片檔不需要）。
- 筆跡外框以筆畫代號快取；套索移動或改顏色後代號不變，所以用內容比對判斷要不要重算（`ink.ts` 的 `sameStroke`）。
- 閱讀器、縮圖、匯出都用 `imagePlacement()` 算圖片矩陣（含旋轉），三者才會一致。
- 復原只追蹤本機 origin（`"this-device"`）；同步收到的修改以 `SyncSession` 為 origin，不會被本機復原。修改筆記本一律包在 `nb.doc.transact(fn, LOCAL)`。
- iPad：觸控筆的 `touchstart` 要 `preventDefault`（否則 Safari 反白文字）；「只用觸控筆」時 `touch-action: pan-x pan-y` 讓手指捲動；選取工具下手指按在圖片／選取框上時才 `preventDefault`。兩指縮放時 pdf.js 會移除被按住的元素，所以縮放也監聽那些元素本身（`gestures.ts`）。
- iOS 的 canvas 記憶體上限較低：`lib/device.ts` 的上限，手寫層跟著 pdf.js 釋放。

**連線**
- https 網頁連不到區網的 `ws://`，所以用 WebRTC；不設 STUN（只走區網）。有些環境 ICE 收集永遠不回報完成，所以收到位址後安靜 400 ms 就當作完成。
- 加入方把連線交給筆記本畫面後，關閉加入視窗時**不能**關掉 RTCPeerConnection。
- Linux 軟體版（WebKitGTK）沒有 `RTCPeerConnection`，畫面提示改用瀏覽器（backlog #18）。

**部署與環境**
- Service Worker 快取比對要 `ignoreVary: true`（伺服器回 `Vary: Origin`，否則離線找不到快取）。
- 這個開發容器連不到外部服務（公開的配對伺服器、STUN），GitHub 操作走 MCP 工具。e2e 的環境需求與寫法見 `e2e/README.md`。

## 驗證數字（W13 完成時）

- 單元測試：core 60、notes 56
- 網頁版 e2e 17 組共 297 項；軟體版 e2e 5 組共 31 項；Rust 5 項（`cargo test`，有 LibreOffice 時會實際轉檔）
- CI（`ci.yml`）只跑型別檢查、單元測試、建置；e2e 要在本機或開發容器跑。
