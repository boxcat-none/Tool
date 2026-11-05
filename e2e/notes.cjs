const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument } = require(env.PDF_LIB);
const W2 = env.FIX; const shots = env.out("shots"); const OUT = env.out("w4"); fs.mkdirSync(OUT, { recursive: true });
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const pdf = (name) => ({ name, mimeType: "application/pdf", buffer: fs.readFileSync(path.join(W2, name)) });
const pageNo = (p) => p.locator(".reader__page").inputValue();
const waitPage = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__page")?.value === String(n), n);
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}`, n, { timeout: 20000 });
const inkPixels = (p, page) => p.evaluate((page) => {
  const c = document.querySelector(`.page[data-page-number="${page}"] .ink-layer__pen`);
  if (!c) return -1;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n;
}, page);
/** 縮圖上的藍色筆跡像素 */
const thumbInk = (p, page) => p.evaluate(async (page) => {
  const img = document.querySelector(`.side-thumb[data-page="${page}"] img`);
  if (!img) return -1;
  await img.decode().catch(() => {});
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 60) n++; return n;
}, page);
async function draw(p, page, pts) {
  await p.locator(`.page[data-page-number="${page}"] .ink-input`).waitFor({ state: "attached" });
  const box = await p.locator(`.page[data-page-number="${page}"]`).boundingBox();
  await p.mouse.move(box.x + pts[0][0], box.y + pts[0][1]); await p.mouse.down();
  for (const [x, y] of pts.slice(1)) await p.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await p.mouse.up();
}
const backToLibrary = async (p) => { await p.getByLabel("回到書櫃").click(); await p.getByText("我的筆記本").waitFor(); };
const pageSize = (p) => p.evaluate(() => { const r = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(env.BASE + "/#reader");
  await page.getByText("還沒有筆記本").waitFor();
  check(true, "empty library");

  // ── 新增空白筆記本（橫線）──
  await page.getByRole("button", { name: "橫線" }).click();
  await waitCount(page, 1);
  check(await page.locator(".reader__title").textContent() === "未命名筆記本", "blank notebook opens");
  await page.locator(".page canvas").first().waitFor();
  const lines = await page.evaluate(() => { const c = document.querySelector(".page canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 230 && d[i + 2] > d[i]) n++; return n; });
  check(lines > 1000, "lined paper rendered", lines);
  // 改名
  await page.locator(".reader__title").click();
  await page.getByLabel("筆記本名稱").fill("物理課筆記");
  await page.getByLabel("筆記本名稱").press("Enter");
  check(await page.locator(".reader__title").textContent() === "物理課筆記", "rename notebook");

  // ── 插入頁面 ──
  await page.getByRole("button", { name: "＋ 插入頁面" }).click();
  await page.getByRole("menuitem", { name: "方格" }).click();
  await waitCount(page, 2); await waitPage(page, 2);
  check(true, "insert grid page after current → page 2");
  await page.getByRole("button", { name: "＋ 插入頁面" }).click();
  await page.getByRole("menuitem", { name: "點陣" }).click();
  await waitCount(page, 3); await waitPage(page, 3);
  check(true, "insert dot page → page 3");
  // 在第 2 頁畫線
  await page.getByRole("button", { name: "第 2 頁", exact: true }).click(); await waitPage(page, 2);
  await page.keyboard.press("p");
  await draw(page, 2, [[100, 200], [200, 260], [300, 200]]);
  check(await inkPixels(page, 2) > 100, "draw on inserted grid page");
  await page.waitForFunction(() => { const img = document.querySelector('.side-thumb[data-page="2"] img'); return !!img; });
  await page.waitForTimeout(800);
  const tInk = await thumbInk(page, 2);
  check(tInk > 5, "thumbnail shows ink", tInk);
  await page.screenshot({ path: path.join(shots, "notes-pages.png") });

  // ── 移動、刪除、復原 ──
  await page.getByLabel("第 3 頁往前移").click();
  await waitPage(page, 2);
  const order = await page.evaluate(() => [...document.querySelectorAll(".side-thumb")].map((e) => e.dataset.page));
  check(order.length === 3, "move page keeps 3 pages", order);
  // 移動後顯示用 PDF 會在背景重新產生，完成後畫面停在被移動的那一頁（現在是第 2 頁）
  await page.waitForFunction(() => {
    const thumbs = [...document.querySelectorAll(".side-thumb")];
    return document.querySelector(".reader__page")?.value === "2" && document.querySelector(".reader__saved")?.textContent === "已自動儲存" && thumbs.length === 3;
  });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "第 3 頁", exact: true }).click(); await waitPage(page, 3);
  const moved = await page.waitForFunction(() => {
    const c = document.querySelector('.page[data-page-number="3"] .ink-layer__pen');
    if (!c) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n > 100 ? n : 0;
  }, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => 0);
  check(moved > 100, "inked page moved to position 3", moved);
  await page.getByLabel("刪除第 1 頁").click();
  await waitCount(page, 2);
  check(true, "delete page → 2 pages");
  await page.keyboard.press("Control+z");
  await waitCount(page, 3);
  check(true, "undo restores deleted page");

  // ── 自動儲存：重新整理瀏覽器後仍在 ──
  await page.waitForTimeout(1200);
  await page.reload();
  await page.getByRole("button", { name: "閱讀與筆記" }).click().catch(() => {});
  await page.getByText("物理課筆記").waitFor();
  check((await page.locator(".library__meta").first().textContent()).startsWith("3 頁"), "library shows 3 pages after reload");
  await page.getByText("物理課筆記").click();
  await waitCount(page, 3);
  await page.getByRole("button", { name: "第 3 頁", exact: true }).click(); await waitPage(page, 3);
  await page.locator('.page[data-page-number="3"] .ink-layer__pen').waitFor({ state: "attached" });
  await page.waitForTimeout(300);
  check(await inkPixels(page, 3) > 100, "strokes restored after reload", await inkPixels(page, 3));

  // ── 存成 .guganote ──
  const [gn] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "存成 .guganote" }).click()]);
  check(gn.suggestedFilename() === "物理課筆記.guganote", "save .guganote filename", gn.suggestedFilename());
  const gnPath = path.join(OUT, "物理課筆記.guganote"); fs.copyFileSync(await gn.path(), gnPath);
  await backToLibrary(page);

  // 刪除後從檔案開回來
  page.once("dialog", (d) => d.accept());
  await page.getByLabel("刪除 物理課筆記").click();
  await page.getByText("還沒有筆記本").waitFor();
  check(true, "delete notebook from library");
  await page.locator(".drop input[type=file]").setInputFiles({ name: "物理課筆記.guganote", mimeType: "application/octet-stream", buffer: fs.readFileSync(gnPath) });
  await waitCount(page, 3);
  check(await page.locator(".reader__title").textContent() === "物理課筆記", "open .guganote restores notebook");
  await page.getByRole("button", { name: "第 3 頁", exact: true }).click(); await waitPage(page, 3);
  await page.locator('.page[data-page-number="3"] .ink-layer__pen').waitFor({ state: "attached" }); await page.waitForTimeout(300);
  check(await inkPixels(page, 3) > 100, ".guganote keeps strokes");
  await backToLibrary(page);

  // ── 由 PDF 建立筆記本，再開一次同一份 PDF ──
  await page.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await waitCount(page, 12);
  check(await page.locator(".reader__title").textContent() === "目錄", "PDF creates notebook named after file");
  const [w0, h0] = await pageSize(page);
  await page.keyboard.press("p");
  await draw(page, 1, [[100, 500], [400, 520]]);
  await page.getByRole("tab", { name: "目錄" }).click();
  await page.getByText("第一章 開始").waitFor();
  check(true, "plain PDF notebook shows outline");
  await backToLibrary(page);
  await page.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await page.getByText("這份 PDF 已經有筆記本").waitFor();
  await page.getByRole("button", { name: "接續之前的筆記", exact: true }).click();
  await waitCount(page, 12);
  await page.locator('.page[data-page-number="1"] .ink-layer__pen').waitFor({ state: "attached" }); await page.waitForTimeout(300);
  check(await inkPixels(page, 1) > 100, "reopening same PDF continues notebook with strokes");

  // 在 PDF 筆記本插頁：插在目前頁後面，原本頁面的筆跡位置不變
  await page.getByRole("button", { name: "＋ 插入頁面" }).click();
  await page.getByRole("menuitem", { name: "空白" }).click();
  await waitCount(page, 13); await waitPage(page, 2);
  check(true, "insert blank page into PDF notebook");
  const [w1, h1] = await pageSize(page);
  check(Math.abs(w1 - w0) <= 2 && Math.abs(h1 - h0) <= 2, "page 1 size unchanged after rebuild", { before: [w0, h0], after: [w1, h1] });
  await page.locator(".reader__page").fill("1"); await page.locator(".reader__page").press("Enter"); await waitPage(page, 1);
  await page.locator('.page[data-page-number="1"] .ink-layer__pen').waitFor({ state: "attached" }); await page.waitForTimeout(300);
  check(await inkPixels(page, 1) > 100, "PDF page strokes kept after insert");
  const [ex] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 PDF" }).click()]);
  const exPdf = await PDFDocument.load(fs.readFileSync(await ex.path()));
  check(exPdf.getPageCount() === 13, "export has 13 pages", exPdf.getPageCount());
  check(ex.suggestedFilename() === "目錄.pdf", "export filename", ex.suggestedFilename());
  await backToLibrary(page);

  // 建立新的（不接續）
  await page.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await page.getByRole("button", { name: "建立新的筆記本", exact: true }).click();
  await waitCount(page, 12);
  await backToLibrary(page);
  check(await page.locator(".library__item").count() === 3, "library has 3 notebooks", await page.locator(".library__item").count());
  const titles = await page.locator(".library__title").allTextContents();
  check(titles.includes("目錄") && titles.includes("目錄 (2)"), "second notebook from same PDF gets numbered title", titles);
  await page.screenshot({ path: path.join(shots, "notes-library.png") });

  // ── 有密碼的 PDF：輸入密碼後可以插頁、匯出 ──
  await page.locator(".drop input[type=file]").setInputFiles(pdf("加密.pdf"));
  await page.getByText("這個 PDF 有密碼保護").waitFor();
  await page.getByLabel("請輸入開啟密碼").fill("secret123");
  await page.getByRole("button", { name: "開啟", exact: true }).click();
  await waitCount(page, 12);
  check(await page.getByRole("button", { name: "＋ 插入頁面" }).isEnabled(), "encrypted: insert enabled after password");
  await page.keyboard.press("p");
  await draw(page, 1, [[100, 500], [300, 520]]);
  check(await inkPixels(page, 1) > 100, "encrypted: can write notes");
  await page.getByRole("button", { name: "＋ 插入頁面" }).click();
  await page.getByRole("menuitem", { name: "方格" }).click();
  await waitCount(page, 13);
  check(true, "encrypted: insert page (decrypted in worker with password)");
  const [encEx] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 PDF" }).click()]);
  const encOut = await PDFDocument.load(fs.readFileSync(await encEx.path()));
  check(encOut.getPageCount() === 13 && !encOut.isEncrypted, "encrypted: export is 13 pages without password", { pages: encOut.getPageCount(), encrypted: encOut.isEncrypted });
  await page.getByText("匯出的 PDF 沒有密碼保護").waitFor();
  check(true, "encrypted: export warns output has no password");
  await backToLibrary(page);

  // 重新開啟（頁面已調整，要先輸入密碼才能重新產生）：先輸錯再輸對
  await page.locator(".library__open").first().click();
  await page.getByText("這個 PDF 有密碼保護").waitFor();
  await page.getByLabel("請輸入開啟密碼").fill("wrong-password");
  await page.getByRole("button", { name: "開啟", exact: true }).click();
  await page.getByText("密碼不正確").waitFor();
  check(true, "encrypted: wrong password on reopen");
  await page.getByLabel("請輸入開啟密碼").fill("secret123");
  await page.getByRole("button", { name: "開啟", exact: true }).click();
  await waitCount(page, 13);
  await page.locator('.page[data-page-number="1"] .ink-layer__pen').waitFor({ state: "attached" }); await page.waitForTimeout(300);
  check(await inkPixels(page, 1) > 100, "encrypted notebook reopens with strokes after password");

  // 調整過頁面的 PDF 筆記本也有目錄
  await backToLibrary(page);
  await page.getByText("目錄", { exact: true }).first().click();
  await waitCount(page, 13);
  await page.getByRole("tab", { name: "目錄" }).click();
  await page.getByText("第二章 結尾").click();
  await page.waitForFunction(() => document.querySelector(".reader__page")?.value === "11");
  check(true, "outline works after inserting a page (chapter 2 → page 11)");

  check(errors.filter((e) => !e.includes("Cannot load system font")).length === 0, "no console/page errors", errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
