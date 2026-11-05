// W13：圖片旋轉；在有旋轉的頁面插入圖片時保持正向；匯出 PDF 方向一致
const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument, degrees } = require(env.PDF_LIB);
const OUT = env.out("w13"); fs.mkdirSync(OUT, { recursive: true });
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}`, n, { timeout: 20000 });
const imgBox = (p) => p.locator('.page[data-page-number="1"] .note-image').first().boundingBox();
/** 螢幕上某點的顏色：red / blue / other */
async function colorAt(p, x, y) {
  const buf = await p.screenshot({ clip: { x: x - 1, y: y - 1, width: 3, height: 3 } });
  return p.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    const [r, g, b] = ctx.getImageData(1, 1, 1, 1).data;
    return r > 180 && b < 120 ? "red" : b > 180 && r < 100 ? "blue" : `other(${r},${g},${b})`;
  }, buf.toString("base64"));
}
/** 圖片上、右、下、左四個取樣點的顏色（離邊 15%） */
async function sides(p) {
  const b = await imgBox(p);
  const s = await Promise.all([
    colorAt(p, b.x + b.width / 2, b.y + b.height * 0.15),
    colorAt(p, b.x + b.width * 0.85, b.y + b.height / 2),
    colorAt(p, b.x + b.width / 2, b.y + b.height * 0.85),
    colorAt(p, b.x + b.width * 0.15, b.y + b.height / 2),
  ]);
  return { top: s[0], right: s[1], bottom: s[2], left: s[3] };
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const A = await ctx.newPage();
  const errors = []; A.on("pageerror", (e) => errors.push(e.message));
  await A.goto(env.BASE + "/");
  await A.getByText("新增空白筆記本").waitFor();
  // 左紅右藍
  const b64 = await A.evaluate(() => { const c = document.createElement("canvas"); c.width = 200; c.height = 100; const x = c.getContext("2d"); x.fillStyle = "#e11d48"; x.fillRect(0, 0, 100, 100); x.fillStyle = "#2563eb"; x.fillRect(100, 0, 100, 100); return c.toDataURL("image/png").split(",")[1]; });
  const png = { name: "左紅右藍.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") };

  await A.getByRole("button", { name: "空白" }).click();
  await waitCount(A, 1);
  await A.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles(png);
  await A.waitForFunction(() => { const i = document.querySelector(".note-image"); return i && i.complete && i.naturalWidth > 0; });
  let sd = await sides(A);
  check(sd.left === "red" && sd.right === "blue", "inserted: red on the left", sd);
  const b0 = await imgBox(A);

  // 旋轉一次（順時針 90 度）：變成直的，紅色在上
  await A.getByRole("button", { name: "旋轉" }).click();
  await A.waitForTimeout(200);
  const b1 = await imgBox(A);
  check(Math.abs(b1.height / b1.width - 2) < 0.02, "rotate → portrait box", b1.height / b1.width);
  check(Math.abs(b1.x + b1.width / 2 - (b0.x + b0.width / 2)) < 2 && Math.abs(b1.y + b1.height / 2 - (b0.y + b0.height / 2)) < 2, "rotates around its center");
  const s1 = await sides(A);
  check(s1.top === "red" && s1.bottom === "blue", "content turned clockwise: red on top, blue at bottom", s1);
  const sel = await A.locator(".image-select:visible").boundingBox();
  check(Math.abs(sel.width - b1.width) < 3 && Math.abs(sel.height - b1.height) < 3, "selection box matches the rotated image", [sel.width, b1.width]);

  // 再轉三次回到原樣
  for (let i = 0; i < 3; i++) await A.getByRole("button", { name: "旋轉" }).click();
  await A.waitForTimeout(200);
  const b4 = await imgBox(A);
  sd = await sides(A);
  check(Math.abs(b4.width - b0.width) < 2 && sd.left === "red" && sd.right === "blue", "four rotations → back to original", sd);

  // 復原：回到轉三次的狀態（紅在右）
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  sd = await sides(A);
  check(sd.top === "blue" && sd.bottom === "red", "undo reverts the last rotation (back to 270°: blue on top)", sd);

  // 旋轉後還能縮放：保持比例
  await A.getByRole("button", { name: "旋轉" }).click(); // 回到 0 度
  await A.getByRole("button", { name: "旋轉" }).click(); // 90 度
  await A.waitForTimeout(200);
  const before = await imgBox(A);
  const s = await A.locator(".image-select:visible").boundingBox();
  await A.mouse.move(s.x + s.width - 1, s.y + s.height - 1); await A.mouse.down(); await A.mouse.move(s.x + s.width + 25, s.y + s.height + 50, { steps: 6 }); await A.mouse.up();
  const after = await imgBox(A);
  check(after.height > before.height + 30 && Math.abs(after.height / after.width - 2) < 0.03, "resize a rotated image keeps ratio", after.height / after.width);
  sd = await sides(A);
  check(sd.top === "red" && sd.bottom === "blue", "still red on top after resize", sd);

  // ── 有旋轉的頁面（/Rotate 90，例如掃描的橫向頁）：插入的圖片在畫面上是正的 ──
  const src = await PDFDocument.create(); const pg = src.addPage([595, 842]); pg.setRotation(degrees(90));
  await A.getByLabel("回到書櫃").click(); await A.getByText("我的筆記本").waitFor();
  await A.locator(".drop input[type=file]").setInputFiles({ name: "橫向頁.pdf", mimeType: "application/pdf", buffer: Buffer.from(await src.save()) });
  await waitCount(A, 1);
  const pageBox = await A.locator('.page[data-page-number="1"]').boundingBox();
  check(pageBox.width > pageBox.height, "rotated page displays landscape", [pageBox.width, pageBox.height]);
  await A.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles(png);
  await A.waitForFunction(() => { const i = document.querySelector('.page[data-page-number="1"] .note-image'); return i && i.complete && i.naturalWidth > 0; });
  const rb = await imgBox(A);
  check(Math.abs(rb.width / rb.height - 2) < 0.02, "image on rotated page shows landscape (upright)", rb.width / rb.height);
  sd = await sides(A);
  check(sd.left === "red" && sd.right === "blue", "…red on the left, as in the original", sd);
  await A.screenshot({ path: path.join(OUT, "rotated-page.png") });

  // 匯出後重新開啟：方向一樣
  const [ex] = await Promise.all([A.waitForEvent("download"), A.getByRole("button", { name: "匯出 PDF" }).click()]);
  const pdfPath = path.join(OUT, "rotated.pdf"); fs.copyFileSync(await ex.path(), pdfPath);
  await A.getByLabel("回到書櫃").click(); await A.getByText("我的筆記本").waitFor();
  await A.locator(".drop input[type=file]").setInputFiles({ name: "匯出.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(pdfPath) });
  await waitCount(A, 1);
  await A.waitForTimeout(1500);
  const pb = await A.locator('.page[data-page-number="1"]').boundingBox();
  // 原本圖片在頁面上的相對位置
  const rel = { x: (rb.x - pageBox.x) / pageBox.width, y: (rb.y - pageBox.y) / pageBox.height, w: rb.width / pageBox.width, h: rb.height / pageBox.height };
  const ex0 = { x: pb.x + rel.x * pb.width, y: pb.y + rel.y * pb.height, w: rel.w * pb.width, h: rel.h * pb.height };
  const left = await colorAt(A, ex0.x + ex0.w * 0.15, ex0.y + ex0.h / 2);
  const right = await colorAt(A, ex0.x + ex0.w * 0.85, ex0.y + ex0.h / 2);
  check(left === "red" && right === "blue", "exported PDF shows the image upright in the same place", [left, right]);

  check(errors.length === 0, "no page errors", errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
