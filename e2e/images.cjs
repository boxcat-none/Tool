// W12：插入圖片、選取、移動、縮放、刪除、復原、縮圖、匯出、儲存、同步
const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument, PDFName, PDFDict, PDFRawStream } = require(env.PDF_LIB);
const OUT = env.out("w12"); fs.mkdirSync(OUT, { recursive: true });
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}`, n, { timeout: 20000 });
const imgBox = (p, i = 0) => p.locator('.page[data-page-number="1"] .note-image').nth(i).boundingBox();
const imgCount = (p, page = 1) => p.locator(`.page[data-page-number="${page}"] .note-image`).count();
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
const exif6 = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

/** 在瀏覽器裡用 canvas 產生測試圖片（左半紅、右半藍） */
async function makeImage(p, w, h, type) {
  const b64 = await p.evaluate(([w, h, type]) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#e11d48"; ctx.fillRect(0, 0, w / 2, h); ctx.fillStyle = "#2563eb"; ctx.fillRect(w / 2, 0, w / 2, h);
    return c.toDataURL(type).split(",")[1];
  }, [w, h, type]);
  return Buffer.from(b64, "base64");
}
async function pair(a, b) {
  await a.locator(".reader__connect").click();
  await a.getByRole("button", { name: /邀請另一台裝置|再邀請一台裝置/ }).click();
  const offer = await a.getByRole("textbox", { name: "① 把這段邀請碼傳到另一台裝置" }).inputValue();
  await b.getByRole("button", { name: "加入其他裝置的筆記本（測試版）" }).click();
  await b.getByRole("textbox", { name: "邀請碼" }).fill(offer);
  await b.getByRole("button", { name: "產生回覆碼" }).click();
  const answer = await b.getByRole("textbox", { name: "② 把這段回覆碼傳回邀請的裝置貼上" }).inputValue();
  await a.getByRole("textbox", { name: "回覆碼" }).fill(answer);
  await a.getByRole("dialog").getByRole("button", { name: "連線", exact: true }).click();
  await a.getByText(/已連上 .+，開始同步/).waitFor({ timeout: 20000 }).catch(async (e) => {
    console.log("PAIR FAIL A:", await a.locator("[role=dialog]").innerText().catch(() => "-"));
    console.log("PAIR FAIL B:", await b.locator("[role=dialog]").innerText().catch(() => "-"), await b.locator(".reader__count").textContent().catch(() => "-"));
    throw e;
  });
  await a.getByRole("button", { name: "關閉" }).click();
}

(async () => {
  const browser = await chromium.launch();
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true }); const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); await p.goto(env.BASE + "/"); await p.getByText("新增空白筆記本").waitFor(); return p; };
  const A = await mk();
  await A.getByRole("button", { name: "空白" }).click();
  await waitCount(A, 1);
  const png = await makeImage(A, 400, 200, "image/png");

  // ── 插入 ──
  await A.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles({ name: "圖表.png", mimeType: "image/png", buffer: png });
  await A.locator('.page[data-page-number="1"] .note-image').waitFor();
  await A.waitForFunction(() => { const i = document.querySelector(".note-image"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
  check(true, "image inserted and loaded");
  check(await A.getByRole("radio", { name: /^選取（/ }).getAttribute("aria-checked") === "true", "tool switches to 選取 after insert");
  check(await A.locator(".image-select").isVisible(), "new image is selected (selection box visible)");
  const page = await A.locator('.page[data-page-number="1"]').boundingBox();
  let b = await imgBox(A);
  check(near(b.width / b.height, 2, 0.02), "aspect ratio kept (400×200)", b.width / b.height);
  check(near(b.x + b.width / 2, page.x + page.width / 2, 2) && near(b.y + b.height / 2, page.y + page.height / 2, 2), "placed at page center");
  check(near(b.width, 300 * (page.width / 595.28), 3), "default size: 96 DPI (400 px = 300 pt)", [b.width, page.width]);
  const order = await A.evaluate(() => [...document.querySelector('.page[data-page-number="1"] .ink-layer').children].map((c) => c.className));
  check(order[0] === "note-images" && order.indexOf("ink-layer__pen") > 0, "images are below the ink canvases", order);

  // ── 移動 ──
  const before = await imgBox(A);
  await A.mouse.move(before.x + before.width / 2, before.y + before.height / 2); await A.mouse.down();
  await A.mouse.move(before.x + before.width / 2 + 100, before.y + before.height / 2 + 50, { steps: 8 }); await A.mouse.up();
  b = await imgBox(A);
  check(near(b.x - before.x, 100) && near(b.y - before.y, 50), "drag moves the image", [b.x - before.x, b.y - before.y]);

  // ── 縮放（右下角） ──
  const sel = await A.locator(".image-select").boundingBox();
  await A.mouse.move(sel.x + sel.width - 1, sel.y + sel.height - 1); await A.mouse.down();
  await A.mouse.move(sel.x + sel.width + 120, sel.y + sel.height + 60, { steps: 8 }); await A.mouse.up();
  const resized = await imgBox(A);
  check(resized.width > b.width + 100 && near(resized.width / resized.height, 2, 0.03), "corner drag resizes, keeps aspect ratio", [b.width, resized.width, resized.width / resized.height]);
  check(near(resized.x, b.x, 2) && near(resized.y, b.y, 2), "opposite corner stays put");

  // ── 復原／重做 ──
  await A.keyboard.press("Control+z");
  b = await imgBox(A);
  check(near(b.width, (await imgBox(A)).width) && b.width < resized.width - 50, "undo restores the size", b.width);
  await A.keyboard.press("Control+Shift+z");
  check(near((await imgBox(A)).width, resized.width, 1), "redo re-applies");

  // ── 點空白處取消選取；點圖片選取 ──
  await A.mouse.click(page.x + 20, page.y + 20);
  check(!(await A.locator(".image-select").isVisible()), "click on empty area deselects");
  const r2 = await imgBox(A);
  await A.mouse.click(r2.x + 10, r2.y + 10);
  check(await A.locator(".image-select").isVisible(), "click on image selects it");

  // ── 刪除（按鈕）+ 復原 ──
  await A.getByRole("button", { name: "刪除", exact: true }).click();
  check(await imgCount(A) === 0, "刪除 button removes the image");
  await A.keyboard.press("Control+z");
  await A.locator('.page[data-page-number="1"] .note-image').waitFor();
  check(await imgCount(A) === 1, "undo brings it back");

  // ── 第二張：JPEG 帶 EXIF 方向 6（手機直拍）→ 轉正後是直的 ──
  const jpg = await makeImage(A, 300, 200, "image/jpeg");
  const rotated = Buffer.concat([jpg.subarray(0, 2), Buffer.from(exif6), jpg.subarray(2)]);
  await A.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles({ name: "照片.jpg", mimeType: "image/jpeg", buffer: rotated });
  await A.waitForFunction(() => document.querySelectorAll('.page[data-page-number="1"] .note-image').length === 2);
  const photo = await imgBox(A, 1);
  check(near(photo.height / photo.width, 1.5, 0.03), "EXIF-rotated photo inserted upright (portrait)", photo.height / photo.width);

  // Delete 鍵
  await A.keyboard.press("Delete");
  check(await imgCount(A) === 1, "Delete key removes the selected image");

  // ── 貼上 ──
  const pasted = await A.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], "截圖.png", { type: "image/png" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    return document.querySelectorAll('.page[data-page-number="1"] .note-image').length;
  }, png.toString("base64"));
  check(pasted === 2, "Ctrl+V pastes an image", pasted);
  await A.keyboard.press("Delete");

  // ── 在圖片上寫字：筆跡在圖片上面 ──
  await A.keyboard.press("p");
  await A.getByRole("radio", { name: "粗" }).click();
  const im = await imgBox(A);
  await A.mouse.move(im.x + 10, im.y + im.height / 2); await A.mouse.down(); await A.mouse.move(im.x + im.width - 10, im.y + im.height / 2, { steps: 8 }); await A.mouse.up();
  // 畫面上筆跡經過的地方是深色（筆跡），不是圖片的紅色或藍色
  const shotBuf = await A.screenshot({ clip: { x: im.x + im.width / 2 - 3, y: im.y + im.height / 2 - 3, width: 6, height: 6 } });
  const px = await A.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let min = 765;
    for (let i = 0; i < d.length; i += 4) min = Math.min(min, d[i] + d[i + 1] + d[i + 2]);
    return min;
  }, shotBuf.toString("base64"));
  // 圖片的紅 (225,29,72) 加總 326、藍 (37,99,235) 加總 371；筆跡 #1e40af 加總 269
  check(px < 300, "ink is drawn on top of the image (pen color over the photo)", px);

  // ── 縮圖 ──
  await A.waitForFunction(() => !!document.querySelector('.side-thumb[data-page="1"] img'), null, { timeout: 10000 }).catch(() => {});
  await A.waitForTimeout(1200);
  const thumbColors = await A.evaluate(async () => {
    const img = document.querySelector('.side-thumb[data-page="1"] img'); if (!img) return null;
    await img.decode().catch(() => {});
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let red = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] > 180 && d[i + 2] < 120 && d[i + 1] < 80) red++; if (d[i + 2] > 180 && d[i] < 80) blue++; }
    return { red, blue };
  });
  check(thumbColors && thumbColors.red > 20 && thumbColors.blue > 20, "thumbnail shows the image", thumbColors);

  // ── 縮放畫面：圖片跟著頁面 ──
  const ratioBefore = (await imgBox(A)).width / (await A.locator('.page[data-page-number="1"]').boundingBox()).width;
  await A.getByRole("button", { name: "放大" }).click();
  await A.waitForTimeout(800);
  const ratioAfter = (await imgBox(A)).width / (await A.locator('.page[data-page-number="1"]').boundingBox()).width;
  check(near(ratioBefore, ratioAfter, 0.005), "image scales with the page when zooming", [ratioBefore, ratioAfter]);
  await A.getByRole("button", { name: "縮小" }).click();
  await A.waitForTimeout(500);

  // ── 匯出 PDF ──
  const [ex] = await Promise.all([A.waitForEvent("download"), A.getByRole("button", { name: "匯出 PDF" }).click()]);
  const pdfPath = path.join(OUT, "images.pdf"); fs.copyFileSync(await ex.path(), pdfPath);
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  const xo = doc.getPage(0).node.Resources().lookupMaybe(PDFName.of("XObject"), PDFDict);
  const imgs = xo ? xo.keys().filter((k) => xo.lookup(k).dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) : [];
  check(imgs.length === 1, "exported PDF contains the image", imgs.length);
  const shot = await A.evaluate(async () => 1); // placeholder

  // ── 重新整理後仍在（自動儲存） ──
  await A.reload();
  await A.getByText("我的筆記本").waitFor();
  await A.locator(".library__open").first().click();
  await A.locator('.page[data-page-number="1"] .note-image').waitFor({ timeout: 10000 });
  await A.waitForFunction(() => { const i = document.querySelector(".note-image"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
  check(true, "image persists after reload");

  // ── .guganote：在另一台裝置開啟 ──
  const [gn] = await Promise.all([A.waitForEvent("download"), A.getByRole("button", { name: "存成 .guganote" }).click()]);
  const gnPath = path.join(OUT, "images.guganote"); fs.copyFileSync(await gn.path(), gnPath);
  const C = await mk();
  await C.locator(".drop input[type=file]").setInputFiles({ name: "images.guganote", mimeType: "application/octet-stream", buffer: fs.readFileSync(gnPath) });
  await C.locator('.page[data-page-number="1"] .note-image').waitFor({ timeout: 10000 });
  await C.waitForFunction(() => { const i = document.querySelector(".note-image"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
  check(true, ".guganote carries the image to another device");

  // ── 同步：A 插入 → B 看到；B 移動 → A 跟著動 ──
  const B = await mk();
  await pair(A, B);
  await waitCount(B, 1);
  await B.locator('.page[data-page-number="1"] .note-image').waitFor({ timeout: 10000 });
  check(true, "B receives existing image on join");
  await A.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles({ name: "新圖.jpg", mimeType: "image/jpeg", buffer: await makeImage(A, 200, 200, "image/jpeg") });
  await B.waitForFunction(() => [...document.querySelectorAll('.page[data-page-number="1"] .note-image')].filter((i) => i.complete && i.naturalWidth > 0).length === 2, null, { timeout: 10000 }).then(() => check(true, "image inserted on A appears on B (file transferred)"), () => check(false, "image inserted on A appears on B"));
  await B.keyboard.press("s");
  const bi = await imgBox(B, 1);
  const aBefore = await imgBox(A, 1);
  await B.mouse.move(bi.x + bi.width / 2, bi.y + bi.height / 2); await B.mouse.down(); await B.mouse.move(bi.x + bi.width / 2 - 80, bi.y + bi.height / 2 - 80, { steps: 6 }); await B.mouse.up();
  await A.waitForFunction((x) => { const i = document.querySelectorAll('.page[data-page-number="1"] .note-image')[1]; return i && Math.abs(i.getBoundingClientRect().x - x) > 40; }, aBefore.x, { timeout: 5000 }).then(() => check(true, "B moves the image → A follows"), () => check(false, "B moves the image → A follows"));

  await A.screenshot({ path: path.join(OUT, "images-A.png") });
  for (const [n, p] of [["A", A], ["B", B], ["C", C]]) check(p.errors.length === 0, `no page errors on ${n}`, p.errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
