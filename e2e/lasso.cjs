// W13：套索選取筆跡與圖片 → 移動、改顏色、刪除、復原、同步
const env = require("./lib/env.cjs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}`, n, { timeout: 20000 });
/** 頁面上某個範圍（相對頁面左上角的 CSS px）裡的筆跡像素；color: 只算接近這個顏色的 */
const inkIn = (p, [x0, y0, x1, y1], cls = "ink-layer__pen", color = null) => p.evaluate(([x0, y0, x1, y1, cls, color]) => {
  const page = document.querySelector('.page[data-page-number="1"]');
  const c = page.querySelector("." + cls);
  const k = c.width / page.getBoundingClientRect().width;
  const d = c.getContext("2d").getImageData(Math.round(x0 * k), Math.round(y0 * k), Math.round((x1 - x0) * k), Math.round((y1 - y0) * k)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 100) continue;
    if (color && Math.abs(d[i] - color[0]) + Math.abs(d[i + 1] - color[1]) + Math.abs(d[i + 2] - color[2]) > 60) continue;
    n++;
  }
  return n;
}, [x0, y0, x1, y1, cls, color]);
async function draw(p, box, pts) {
  await p.mouse.move(box.x + pts[0][0], box.y + pts[0][1]); await p.mouse.down();
  for (const [x, y] of pts.slice(1)) await p.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await p.mouse.up();
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
  await a.getByText(/已連上 .+，開始同步/).waitFor({ timeout: 20000 });
  await a.getByRole("button", { name: "關閉" }).click();
}

(async () => {
  const browser = await chromium.launch();
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } }); const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); await p.goto(env.BASE + "/"); await p.getByText("新增空白筆記本").waitFor(); return p; };
  const A = await mk();
  await A.getByRole("button", { name: "空白" }).click();
  await waitCount(A, 1);
  await A.keyboard.press("p");
  await A.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" });
  const box = await A.locator('.page[data-page-number="1"]').boundingBox();
  // 兩筆在左上（要圈選），一筆在右下（不圈）
  await draw(A, box, [[100, 150], [220, 170]]);
  await draw(A, box, [[100, 250], [220, 270]]);
  await draw(A, box, [[500, 550], [620, 570]]);
  const total = await inkIn(A, [0, 0, box.width, box.height]);
  const left = await inkIn(A, [60, 120, 260, 300]);
  const far = await inkIn(A, [460, 520, 660, 600]);
  check(left > 100 && far > 50, "three strokes drawn", { left, far });

  // ── 套索圈選左邊兩筆 ──
  await A.keyboard.press("s");
  await draw(A, box, [[60, 110], [280, 110], [280, 310], [60, 310], [60, 115]]);
  check(await A.locator(".lasso-select:visible").count() === 1, "lasso selection box appears");
  const sel = await A.locator(".lasso-select:visible").boundingBox();
  check(sel.x - box.x < 110 && sel.x + sel.width - box.x > 210 && sel.y - box.y < 160 && sel.y + sel.height - box.y > 260 && sel.x + sel.width - box.x < 300, "selection box wraps the two strokes only", [sel.x - box.x, sel.y - box.y, sel.width, sel.height]);
  check(await A.locator(".lasso-select__colors:visible").count() === 1, "color buttons shown for strokes");

  // ── 拖曳移動 ──
  await A.mouse.move(sel.x + sel.width / 2, sel.y + sel.height / 2); await A.mouse.down();
  await A.mouse.move(sel.x + sel.width / 2 + 150, sel.y + sel.height / 2 + 100, { steps: 5 });
  const liveDuring = await inkIn(A, [200, 200, 420, 420], "ink-input__live");
  const penDuring = await inkIn(A, [60, 120, 260, 300]);
  check(liveDuring > 100 && penDuring === 0, "while dragging: strokes follow the pointer (lifted off the page)", { liveDuring, penDuring });
  await A.mouse.move(sel.x + sel.width / 2 + 150, sel.y + sel.height / 2 + 100, { steps: 2 });
  await A.mouse.up();
  await A.waitForTimeout(200);
  const movedOld = await inkIn(A, [60, 120, 230, 300]);
  const movedNew = await inkIn(A, [210, 220, 410, 400]);
  check(movedOld === 0 && movedNew > 100, "strokes moved by the drag", { movedOld, movedNew });
  check(Math.abs((await inkIn(A, [460, 520, 660, 600])) - far) < 5, "unselected stroke stays put");
  check(Math.abs((await inkIn(A, [0, 0, box.width, box.height])) - total) < total * 0.05, "nothing lost or duplicated", [total, await inkIn(A, [0, 0, box.width, box.height])]);
  const sel2 = await A.locator(".lasso-select:visible").boundingBox();
  check(Math.abs(sel2.x - sel.x - 150) < 3 && Math.abs(sel2.y - sel.y - 100) < 3, "selection box moves with them");

  // ── 復原（一步回去）、重做 ──
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  check(await inkIn(A, [60, 120, 260, 300]) > 100 && (await inkIn(A, [240, 240, 410, 400])) === 0, "undo moves both strokes back in one step", [await inkIn(A, [60, 120, 260, 300]), await inkIn(A, [240, 240, 410, 400])]);
  await A.keyboard.press("Control+Shift+z");
  await A.waitForTimeout(200);
  check(await inkIn(A, [210, 220, 410, 400]) > 100, "redo moves them again");

  // ── 改顏色 ──
  await A.locator(".lasso-select__color").nth(2).click(); // 紅色 #dc2626
  await A.waitForTimeout(200);
  const red = await inkIn(A, [210, 220, 410, 400], "ink-layer__pen", [220, 38, 38]);
  const farRed = await inkIn(A, [460, 520, 660, 600], "ink-layer__pen", [220, 38, 38]);
  check(red > 100 && farRed === 0, "recolor: selected strokes turn red, others unchanged", { red, farRed });

  // ── 刪除（Delete 鍵）與復原 ──
  await A.keyboard.press("Delete");
  await A.waitForTimeout(200);
  check(await inkIn(A, [210, 220, 410, 400]) === 0 && await A.locator(".lasso-select:visible").count() === 0, "Delete removes the selection");
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  check(await inkIn(A, [210, 220, 410, 400]) > 100, "undo restores deleted strokes");

  // ── 點空白處取消選取 ──
  await A.mouse.click(box.x + 700, box.y + 100);
  check(await A.locator(".lasso-select:visible").count() === 0, "click on empty area clears selection");

  // ── 圈選圖片和筆跡，一起移動 ──
  const b64 = await A.evaluate(() => { const c = document.createElement("canvas"); c.width = 120; c.height = 80; const x = c.getContext("2d"); x.fillStyle = "#16a34a"; x.fillRect(0, 0, 120, 80); return c.toDataURL("image/png").split(",")[1]; });
  await A.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles({ name: "綠.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
  await A.locator(".note-image").waitFor();
  const img0 = await A.locator(".note-image").boundingBox();
  // 圈住圖片與右下那一筆
  const ix = img0.x - box.x, iy = img0.y - box.y;
  await A.mouse.click(box.x + 700, box.y + 100); // 取消選取圖片
  await draw(A, box, [[ix - 20, iy - 20], [680, iy - 20], [680, 620], [ix - 20, 620], [ix - 20, iy - 15]]);
  const sel3 = await A.locator(".lasso-select:visible").boundingBox();
  check(sel3 && sel3.width > img0.width, "lasso can select an image together with strokes");
  await A.mouse.move(img0.x + img0.width / 2, img0.y + img0.height / 2); await A.mouse.down();
  await A.mouse.move(img0.x + img0.width / 2 - 60, img0.y + img0.height / 2 - 40, { steps: 6 });
  const imgDuring = await A.locator(".note-image").boundingBox();
  check(Math.abs(imgDuring.x - img0.x + 60) < 3, "image follows during the drag", imgDuring.x - img0.x);
  await A.mouse.up();
  await A.waitForTimeout(200);
  const img1 = await A.locator(".note-image").boundingBox();
  check(Math.abs(img1.x - img0.x + 60) < 3 && Math.abs(img1.y - img0.y + 40) < 3, "image moved with the selection", [img1.x - img0.x, img1.y - img0.y]);
  check(await inkIn(A, [440, 495, 498, 540]) > 20 && (await inkIn(A, [565, 545, 625, 580])) === 0, "the stroke in the selection moved too");
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  const img2 = await A.locator(".note-image").boundingBox();
  check(Math.abs(img2.x - img0.x) < 3, "one undo moves image and stroke back together");

  // ── 同步：A 移動 → B 看到 ──
  const B = await mk();
  await pair(A, B);
  await waitCount(B, 1);
  await B.waitForTimeout(500);
  const bBefore = await inkIn(B, [0, 0, box.width, 300]);
  await A.keyboard.press("s");
  await A.mouse.click(box.x + 700, box.y + 100);
  await draw(A, box, [[60, 110], [480, 110], [480, 420], [60, 420], [60, 115]]);
  const s4 = await A.locator(".lasso-select:visible").boundingBox();
  await A.mouse.move(s4.x + 20, s4.y + 20); await A.mouse.down(); await A.mouse.move(s4.x + 20, s4.y + 320, { steps: 6 }); await A.mouse.up();
  await B.waitForFunction(([y0]) => {
    const page = document.querySelector('.page[data-page-number="1"]'); const c = page.querySelector(".ink-layer__pen");
    const k = c.width / page.getBoundingClientRect().width; const d = c.getContext("2d").getImageData(0, 0, c.width, Math.round(300 * k)).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++; return n === 0;
  }, [0], { timeout: 5000 }).then(() => check(true, "B sees the strokes moved away"), () => check(false, "B sees the strokes moved away", bBefore));

  for (const [n, p] of [["A", A], ["B", B]]) check(p.errors.length === 0, `no page errors on ${n}`, p.errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
