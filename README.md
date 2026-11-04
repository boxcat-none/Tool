# Tool

文件處理工具箱。所有處理都在使用者的電腦上完成，檔案不會上傳。

目前功能：

- **合併 PDF**：多個 PDF 依順序合成一個，可以拖拉或用按鈕調整順序
- **分割 PDF**：依範圍分割、每頁一個檔案、每 N 頁一份、擷取頁面合成單一檔案
- **整理頁面**：用縮圖旋轉、刪除頁面，或拖拉調整順序；可以多選後一次處理
- **JPG/PNG 轉 PDF**：JPG、PNG（以及 WebP、GIF 等）圖片合成一個 PDF，可選 A4 / Letter / 與圖片相同大小、方向與邊界；手機照片會依 EXIF 自動轉正
- **PDF 轉 JPG/PNG**：每頁轉成一張圖片，可選格式、解析度（72 / 150 / 300 DPI）、JPG 品質與要轉的頁面；多張圖片打包成 ZIP

## 開發

需要 Node.js 20 以上和 pnpm 10。

```bash
pnpm install
pnpm dev         # 啟動網頁版開發伺服器
pnpm test        # 執行核心邏輯測試
pnpm typecheck   # TypeScript 型別檢查
pnpm build       # 建置網頁版到 apps/web/dist
```

## 專案結構

```
packages/core/   PDF 處理邏輯（合併、分割、整理頁面、圖片與 PDF 互轉的計算），不依賴 UI，網頁版和軟體版共用
apps/web/        網頁版（React + Vite），PDF 處理在 Web Worker 裡執行，縮圖與 PDF 轉圖片用 pdf.js
```

`apps/web/src/lib/platform.ts` 是平台層：網頁版用瀏覽器下載，之後的軟體版（Tauri）只要替換這一層，就能改成原生的存檔對話框。

## 部署

`.github/workflows/ci.yml` 會在 PR 和推送到 `main` 時執行型別檢查、測試、建置；
推送到 `main` 時再把網頁版部署到 GitHub Pages。

第一次使用前，需要在 GitHub 的 repo 設定開啟 Pages：
**Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。

## 頁碼範圍語法

| 輸入 | 意思 |
|---|---|
| `1-3, 5, 8-` | 第 1–3 頁、第 5 頁、第 8 頁到最後 |
| `-2` | 第 1–2 頁 |
| `5-3` | 第 5、4、3 頁（倒序） |

分隔符號可以用半形或全形逗號、頓號、分號或空白，範圍符號可以用 `-`、`–`、`~`、`～`。
