# Tool

文件處理工具箱，有網頁版和軟體版（Windows、macOS、Linux）。所有處理都在使用者的電腦上完成，檔案不會上傳。

目前功能：

- **閱讀與筆記**（開啟程式預設畫面）：書櫃（筆記本自動儲存在這台裝置）、由 PDF 建立筆記本或新增空白筆記本；插入空白、橫線、方格、點陣頁，移動、刪除頁面；手寫（鋼筆有壓力感應、螢光筆、橡皮擦、復原重做）；側邊欄縮圖（含筆跡）與目錄、全文搜尋（支援中文）、有密碼的 PDF（輸入密碼後也能插頁、匯出）；插入圖片（手機照片自動轉正並移除拍攝地點，可以直接貼上截圖），用「選取」工具移動、縮放、刪除；
  調整頁面後目錄仍正確；存成 `.guganote` 或匯出 PDF；加入主畫面後可以離線使用；
  **連線到其他裝置（測試版）**：iPad 和電腦在同一個 Wi-Fi 下直接連線（WebRTC），即時同步同一本筆記本

- **合併 PDF**：多個 PDF 依順序合成一個，可以拖拉或用按鈕調整順序
- **分割 PDF**：依範圍分割、每頁一個檔案、每 N 頁一份、擷取頁面合成單一檔案
- **整理頁面**：用縮圖旋轉、刪除頁面，或拖拉調整順序；可以多選後一次處理
- **JPG/PNG 轉 PDF**：JPG、PNG（以及 WebP、GIF 等）圖片合成一個 PDF，可選 A4 / Letter / 與圖片相同大小、方向與邊界；手機照片會依 EXIF 自動轉正
- **PDF 轉 JPG/PNG**：每頁轉成一張圖片，可選格式、解析度（72 / 150 / 300 DPI）、JPG 品質與要轉的頁面；多張圖片打包成 ZIP
- **Office 轉 PDF**（僅軟體版）：Word、Excel、PowerPoint 及 OpenDocument 檔案轉成 PDF，需要另外安裝免費的 [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/)

軟體版和網頁版功能相同（另外多了 Office 轉 PDF），差別在存檔：軟體版會跳出「另存新檔」或「選擇資料夾」對話框，直接存到硬碟，不會打包成 ZIP。

已知限制與待解決項目見 [`docs/backlog.md`](docs/backlog.md)。

## 開發

需要 Node.js 20 以上和 pnpm 10。

```bash
pnpm install
pnpm dev         # 啟動網頁版開發伺服器
pnpm test        # 執行核心邏輯測試
pnpm typecheck   # TypeScript 型別檢查
pnpm build       # 建置網頁版到 apps/web/dist
```

軟體版另外需要 [Rust](https://rustup.rs/) 和 [Tauri 的系統套件](https://tauri.app/start/prerequisites/)：

```bash
pnpm --filter @tool/desktop dev     # 開發模式啟動軟體版
pnpm --filter @tool/desktop build   # 打包本機作業系統的安裝檔
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # Rust 測試（有裝 LibreOffice 時會實際轉檔）
```

## 專案結構

```
packages/notes/  筆記本資料模型（Yjs），支援多裝置同時編輯
packages/core/   PDF 處理邏輯（合併、分割、整理頁面、圖片與 PDF 互轉的計算），不依賴 UI，網頁版和軟體版共用
apps/web/        介面（React + Vite），網頁版和軟體版共用；PDF 處理在 Web Worker 裡執行，縮圖與 PDF 轉圖片用 pdf.js
apps/desktop/    軟體版（Tauri）：載入 apps/web 的介面，Rust 端負責存檔、呼叫 LibreOffice 轉檔
```

`apps/web/src/lib/platform.ts` 是平台層：偵測到在 Tauri 裡執行時，存檔改用原生對話框；
軟體版專用的功能都在 `apps/web/src/lib/desktop.ts`，網頁版不會載入。

## 部署

`.github/workflows/ci.yml` 會在 PR 和推送到 `main` 時執行型別檢查、測試、建置；
推送到 `main` 時再把網頁版部署到 GitHub Pages。

第一次使用前，需要在 GitHub 的 repo 設定開啟 Pages：
**Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。

### 軟體版安裝檔

`.github/workflows/desktop.yml` 會打包 Windows（.msi、.exe）、macOS（.dmg，Intel 與 Apple 晶片通用）、Linux（.deb、.rpm、.AppImage）：

- **手動執行**（GitHub → Actions → 軟體版 → Run workflow）：安裝檔放在該次執行的 Artifacts
- **推送標籤**（例如 `git tag v0.1.0 && git push origin v0.1.0`）：另外建立草稿版 Release

安裝檔目前沒有程式碼簽章：Windows 會出現 SmartScreen 警告（點「其他資訊 → 仍要執行」）；
macOS 若顯示「已損毀」，請執行 `xattr -cr "/Applications/PDF Toolbox.app"`。

## 頁碼範圍語法

| 輸入 | 意思 |
|---|---|
| `1-3, 5, 8-` | 第 1–3 頁、第 5 頁、第 8 頁到最後 |
| `-2` | 第 1–2 頁 |
| `5-3` | 第 5、4、3 頁（倒序） |

分隔符號可以用半形或全形逗號、頓號、分號或空白，範圍符號可以用 `-`、`–`、`~`、`～`。
