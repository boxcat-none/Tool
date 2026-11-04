# 筆記本資料模型

程式：`packages/notes/`（模型）、`packages/core/src/ink/`（筆跡編碼與 PDF 讀寫）

## 設計目標

1. **多裝置同時編輯不衝突**：iPad 和電腦各自修改（包含離線時），連線後自動合併。
2. **只復原自己的動作**：在電腦按復原，不會把 iPad 剛畫的線復原掉。
3. **即時同步的資料量小**：每畫一筆只需要傳幾十個 bytes。
4. **筆記本存成自有格式，PDF 用匯出的**（方案 C，與 GoodNotes 相同；2026-11-04 決定）：
   平常存 `.toolnote` 檔，要分享時再匯出 PDF。

## 結構

使用 [Yjs](https://yjs.dev)（CRDT，MIT 授權）。一本筆記本 = 一份 Yjs 文件 + 檔案庫。

```
Y.Doc
├─ meta     Y.Map   { schema: 1, title, createdAt }
├─ pages    Y.Map   pageId → Y.Map { order, source, width, height, rotation }
├─ strokes  Y.Map   pageId → Y.Array<Uint8Array>
│                    每個元素 = 8 bytes 筆畫代號 + 單筆二進位編碼；陣列順序 = 疊放順序
└─ files    Y.Map   fileId → { id, name, mime, size }

檔案庫（不在 Yjs 裡）：原始 PDF、圖片，以 SHA-256 命名，每台裝置只下載一次
```

### 頁面

| 欄位 | 說明 |
|---|---|
| `order` | 排序用字串（fractional indexing）；頁面順序 = 依 `order` 排序，相同時依 `pageId` |
| `source` | `{ kind: "pdf", fileId, index }` 原始 PDF 的第幾頁，或 `{ kind: "template", template }` 插入的紙張（blank / lined / grid / dot） |
| `width`、`height` | 頁面大小（pt） |
| `rotation` | 顯示旋轉 0 / 90 / 180 / 270 |

**為什麼用 fractional indexing 而不是清單**：清單的「移動」= 刪除再插入，兩台裝置同時移動同一頁時，
會變成兩份。fractional indexing 的移動只是改 `order` 這個值，同時修改時以最後一次為準，不會重複。

### 筆跡

- 座標是 PDF 使用者空間（pt，原點左下），不受縮放與顯示旋轉影響。
- **落筆時**（筆離開螢幕）先做 `normalizeStroke`：點精簡（誤差 0.15 pt）、座標取到 0.1 pt、筆壓取到 1/255。
  所以寫的時候看到的、同步到其他裝置的、存成 PDF 再打開的，都是同一份資料。
- 正在畫、還沒放開的那一筆**不寫進 Yjs**，而是透過 Yjs 的 awareness（暫時狀態）即時廣播，
  其他裝置可以看到線條正在被畫出來（W11 實作）。
- 擦除 = 刪除元素；套索移動或改顏色 = 原位置取代，保留疊放順序。

### 復原

`notebook.createUndoManager(origin)` 只追蹤以 `origin` 標記的修改：

```ts
const LOCAL = "this-device";
const undo = nb.createUndoManager(LOCAL);
nb.doc.transact(() => nb.addStroke(pageId, stroke), LOCAL);
undo.undo(); // 只復原本機的動作
```

## 衝突情境（皆有自動測試，見 `packages/notes/test/notebook.test.ts`）

| 情境 | 結果 |
|---|---|
| 兩台裝置離線各自畫線、插頁 | 連線後全部保留，兩邊一致 |
| 同時移動同一頁 | 不會重複，兩邊順序一致 |
| 同時在同一個位置插頁 | 兩頁都保留，兩邊順序一致 |
| 一台刪除頁面、另一台同時在該頁畫線 | 頁面刪除，不會出錯 |
| 復原 | 只復原自己的動作 |

## 資料量（整頁中文筆記，2,186 筆）

| 項目 | 大小 |
|---|---|
| 筆跡未精簡的編碼 | 163.3 KB |
| 精簡後的編碼 | 75.1 KB |
| **Yjs 文件（含所有中繼資料）** | **111.5 KB** |
| **每畫一筆的同步訊息** | **中位數 59 bytes**，最大 666 bytes |
| 新增 2,186 筆 / 讀取解碼全部 | 62 ms / 8 ms |

量測：`pnpm --filter @tool/notes exec vitest run test/size.test.ts`

## 筆記本檔案（.toolnote）

程式：`packages/notes/src/file.ts`。一個 ZIP 檔：

```
manifest.json      { format: "pdf-toolbox-notebook", version: 1, title, savedAt, pages }
notebook.yjs       Yjs 文件（壓縮）；保留合併所需資訊，之後可以和其他裝置的修改合併
files/<sha256>     原始 PDF、圖片（不再壓縮）；只打包仍被頁面使用的檔案
```

- 開啟時檢查格式名稱、版本（太新會提示更新程式）、每個原始檔的雜湊（被竄改或損毀會報錯）、缺少的檔案。
- 用 ZIP 的理由：單一檔案方便備份與分享；格式公開，必要時可以手動解開取回原始 PDF。

## 匯入與匯出 PDF

程式：`packages/notes/src/pdf.ts`、`paper.ts`

- **匯入** `importPdf`：原始檔存進檔案庫，每頁建立一個 `pdf` 頁（保留大小與旋轉）。
- **匯出** `exportPdf`：依頁面順序組合，`pdf` 頁從原始檔複製（同一檔案一次複製，字型等資源只存一份），
  紙張頁畫上格線（相同樣式與尺寸共用一個 Form XObject），再加上筆跡。筆跡有三種模式：

| 模式 | 說明 | 適合 |
|---|---|---|
| `flatten`（預設） | 筆跡畫進頁面內容 | 分享、列印；任何軟體都一樣，檔案最小 |
| `annotations` | 標準手繪註解（不含可編輯資料） | 對方要在 Acrobat 等軟體中隱藏或刪除筆跡 |
| `none` | 不含筆跡 | 只要整理過的頁面 |

匯出的 PDF **不含**可編輯的原始筆跡資料；要繼續編輯請開 `.toolnote` 檔。
（`core/ink` 仍保留 `includeData` 選項與 `readInk`，若之後要支援「PDF 也能繼續編輯」可以直接啟用。）

### 紙張樣式

| 樣式 | 規格 |
|---|---|
| 空白 | — |
| 橫線 | 行距 8 mm，上留 25 mm、下留 12 mm，左右各留 10 mm |
| 方格 | 5 mm，置中排列 |
| 點陣 | 5 mm，每點 1 pt 實心方塊（「長度 0 的圓頭線」在部分 PDF 引擎會消失，所以不用） |

## 大小（方案 C）

| 一頁的筆跡 | 筆畫 | 筆記本檔增加 | 匯出（合併）增加 | 匯出（註解）增加 |
|---|---|---|---|---|
| 零星註記 | 105 | 5.1 KB | 9.2 KB | 11.2 KB |
| 整頁筆記 | 2,184 | **88.2 KB** | 180.5 KB | 216.5 KB |

筆記本檔比方案 D 的 PDF（整頁 277 KB）小約 3 倍，因為只存筆跡資料，不存外觀。
重現：`EXPORT_BENCH_OUT=輸出資料夾 pnpm --filter @tool/notes exec vitest run --dir bench --config /dev/null`

## 後續

- W4：自動儲存（網頁版 IndexedDB／軟體版檔案系統），開啟與儲存 `.toolnote` 的介面。
- W9–W11：同步（Yjs 更新訊息、awareness 即時筆跡、檔案庫傳輸）。
- 圖片（W12）：新增 `images` Y.Map（pageId → 位置、大小、fileId）。
