// W14：複製貼上（筆跡、圖片，含貼到別頁）、圖片上下順序、套索縮放與旋轉；iPad 觸控把手
const env = require("./lib/env.cjs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}`, n, { timeout: 20000 });
/** 某頁某範圍（相對頁面左上角的 CSS px）裡的筆跡像素 */
const inkIn = (p, [x0, y0, x1, y1], pageNo = 1, cls = "ink-layer__pen") => p.evaluate(([x0, y0, x1, y1, pageNo, cls]) => {
  const page = document.querySelector(`.page[data-page-number="${pageNo}"]`);
  const c = page?.querySelector("." + cls);
  if (!c) return -1;
  const k = c.width / page.getBoundingClientRect().width;
  const d = c.getContext("2d").getImageData(Math.round(x0 * k), Math.round(y0 * k), Math.max(1, Math.round((x1 - x0) * k)), Math.max(1, Math.round((y1 - y0) * k))).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++;
  return n;
}, [x0, y0, x1, y1, pageNo, cls]);
async function draw(p, box, pts) {
  await p.mouse.move(box.x + pts[0][0], box.y + pts[0][1]); await p.mouse.down();
  for (const [x, y] of pts.slice(1)) await p.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await p.mouse.up();
}
async function dragTo(p, from, to, steps = 8) {
  await p.mouse.move(from[0], from[1]); await p.mouse.down();
  await p.mouse.move(to[0], to[1], { steps });
  await p.mouse.up();
  await p.waitForTimeout(200);
}
/** 跳到第 n 頁（之後讓頁碼框失去焦點，快捷鍵才有效） */
async function goPage(p, n) {
  await p.locator(".reader__page").fill(String(n)); await p.locator(".reader__page").press("Enter");
  await p.locator(".reader__page").blur();
  await p.waitForTimeout(500);
}
const center = (b) => [b.x + b.width / 2, b.y + b.height / 2];
const selBox = (p) => p.locator(".lasso-select:visible").boundingBox();
/** 螢幕上某點的顏色：red / green / other */
async function colorAt(p, x, y) {
  const buf = await p.screenshot({ clip: { x: x - 1, y: y - 1, width: 3, height: 3 } });
  return p.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
    const [r, g, b] = ctx.getImageData(1, 1, 1, 1).data;
    return r > 180 && g < 100 ? "red" : g > 120 && r < 100 ? "green" : `other(${r},${g},${b})`;
  }, buf.toString("base64"));
}
const makePng = (p, color, w = 240, h = 160) => p.evaluate(([color, w, h]) => {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = color; x.fillRect(0, 0, w, h);
  return c.toDataURL("image/png").split(",")[1];
}, [color, w, h]).then((b64) => Buffer.from(b64, "base64"));
/** 送出剪貼簿事件（headless 的 Ctrl+C／V 不一定會觸發 copy／paste 事件，直接送事件測試處理程式） */
const clipEvent = (p, type) => p.evaluate((type) => {
  const dt = new DataTransfer();
  const ev = new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true });
  document.body.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, text: dt.getData("text/plain") };
}, type);

async function desktop(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const A = await ctx.newPage();
  const errors = []; A.on("pageerror", (e) => errors.push(e.message));
  await A.goto(env.BASE + "/");
  await A.getByRole("button", { name: "空白" }).click();
  await waitCount(A, 1);
  await A.getByRole("button", { name: "＋ 插入頁面" }).click();
  await A.getByRole("menuitem", { name: "空白" }).click();
  await waitCount(A, 2);
  await goPage(A, 1);
  await A.keyboard.press("p");
  await A.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" });
  const box = await A.locator('.page[data-page-number="1"]').boundingBox();
  await draw(A, box, [[100, 150], [260, 150]]);
  await draw(A, box, [[100, 200], [260, 200]]);
  const all = () => inkIn(A, [0, 0, box.width, box.height]);
  const base = await all();
  check(base > 100, "two strokes drawn", base);

  // ── 圈選 → 「複製」按鈕 → 工具列「貼上」 ──
  await A.keyboard.press("s");
  check(await A.getByRole("button", { name: /^貼上複製的內容/ }).count() === 0, "no paste button before copying");
  await draw(A, box, [[70, 120], [300, 120], [300, 230], [70, 230], [70, 125]]);
  const s0 = await selBox(A);
  check(!!s0, "lasso selects the strokes");
  check(await A.locator(".lasso-select [data-order]:visible").count() === 0, "order buttons hidden when only strokes are selected");
  await A.locator(".lasso-select:visible").getByRole("button", { name: "複製" }).click();
  await A.getByText("已複製").waitFor({ timeout: 3000 }).then(() => check(true, "copy shows a toast"), () => check(false, "copy shows a toast"));
  const pasteBtn = A.getByRole("button", { name: /^貼上複製的內容/ });
  check(await pasteBtn.count() === 1, "paste button appears in the toolbar");
  await pasteBtn.click();
  await A.waitForTimeout(300);
  const afterPaste = await all();
  check(afterPaste > base * 1.6, "paste adds a copy of the strokes", [base, afterPaste]);
  const s1 = await selBox(A);
  const dx = s1.x - s0.x, dy = s1.y - s0.y;
  check(dx > 5 && dy > 5 && Math.abs(dx - dy) < 2, "pasted copy is selected and offset down-right on the same page", [dx, dy]);
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  check(Math.abs((await all()) - base) < base * 0.05, "one undo removes the pasted copy", [base, await all()]);

  // ── 鍵盤：copy／paste 事件、Ctrl+D、剪下 ──
  await A.mouse.click(box.x + 700, box.y + 600);
  await draw(A, box, [[70, 120], [300, 120], [300, 230], [70, 230], [70, 125]]);
  const copyEv = await clipEvent(A, "copy");
  check(copyEv.prevented && copyEv.text.includes("筆記內容"), "copy event (Ctrl+C) copies the selection and replaces the system clipboard", copyEv);
  const pasteEv = await clipEvent(A, "paste");
  await A.waitForTimeout(300);
  check(pasteEv.prevented && (await all()) > base * 1.6, "paste event (Ctrl+V) pastes the copied strokes", await all());
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  await A.mouse.click(box.x + 700, box.y + 600);
  await draw(A, box, [[70, 120], [300, 120], [300, 230], [70, 230], [70, 125]]);
  await A.keyboard.press("Control+d");
  await A.waitForTimeout(300);
  check((await all()) > base * 1.6, "Ctrl+D duplicates the selection", await all());
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  await A.mouse.click(box.x + 700, box.y + 600);
  await draw(A, box, [[70, 120], [300, 120], [300, 230], [70, 230], [70, 125]]);
  const cutEv = await clipEvent(A, "cut");
  await A.waitForTimeout(200);
  check(cutEv.prevented && (await all()) === 0, "cut (Ctrl+X) removes the strokes", await all());

  // ── 貼到第 2 頁：同樣的位置 ──
  await goPage(A, 2);
  await A.getByRole("button", { name: /^貼上複製的內容/ }).click();
  await A.waitForTimeout(300);
  const p2 = await inkIn(A, [70, 120, 300, 230], 2);
  check(p2 > 100, "paste onto another page keeps the same position", p2);
  await A.keyboard.press("Control+z"); // 復原貼上
  await A.keyboard.press("Control+z"); // 復原剪下
  await goPage(A, 1);
  check(Math.abs((await all()) - base) < base * 0.05, "undo brings back the cut strokes", [base, await all()]);

  // ── 縮放把手：右下角往外拉 ──
  await A.mouse.click(box.x + 700, box.y + 600);
  await draw(A, box, [[70, 120], [300, 120], [300, 230], [70, 230], [70, 125]]);
  const sa = await selBox(A);
  const handle = await A.locator(".lasso-select:visible .lasso-select__handle").boundingBox();
  await A.mouse.move(...center(handle)); await A.mouse.down();
  await A.mouse.move(center(handle)[0] + 80, center(handle)[1] + 80, { steps: 6 });
  const liveScale = await inkIn(A, [0, 0, box.width, box.height], 1, "ink-input__live");
  check(liveScale > base, "while scaling: the strokes preview larger", [base, liveScale]);
  await A.mouse.up();
  await A.waitForTimeout(200);
  const sb = await selBox(A);
  check(sb.width > sa.width * 1.3 && Math.abs(sb.x - sa.x) < 3 && Math.abs(sb.y - sa.y) < 3, "scale handle: grows from the opposite corner", [sa.width, sb.width, sb.x - sa.x, sb.y - sa.y]);
  check(Math.abs(sb.width / sa.width - sb.height / sa.height) < 0.15, "…and keeps the proportions", [sb.width / sa.width, sb.height / sa.height]);
  check((await all()) > base * 1.3, "scaled strokes are thicker", [base, await all()]);
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  check(Math.abs((await all()) - base) < base * 0.05, "one undo restores the size", [base, await all()]);

  // ── 旋轉把手：從下方拉到左邊 = 順時針 90 度 ──
  await A.mouse.click(box.x + 700, box.y + 600);
  await draw(A, box, [[70, 120], [300, 120], [300, 230], [70, 230], [70, 125]]);
  const sr = await selBox(A);
  const knob = await A.locator(".lasso-select:visible .lasso-select__rotate").boundingBox();
  const [cx, cy] = center(sr);
  const r = center(knob)[1] - cy;
  await A.mouse.move(...center(knob)); await A.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const a = Math.PI / 2 + (i / 12) * (Math.PI / 2); // 6 點鐘 → 9 點鐘
    await A.mouse.move(cx + r * Math.cos(a) + 3, cy + r * Math.sin(a));
  }
  await A.mouse.up();
  await A.waitForTimeout(200);
  const sr2 = await selBox(A);
  check(sr.width > sr.height && sr2.height > sr2.width, "rotate handle turns the strokes (snaps to 90°)", [sr.width, sr.height, sr2.width, sr2.height]);
  check(Math.abs(center(sr2)[0] - cx) < 4 && Math.abs(center(sr2)[1] - cy) < 4, "…around the center", [center(sr2)[0] - cx, center(sr2)[1] - cy]);
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);

  // 自由角度（只有筆跡）：轉 30 度左右
  await A.mouse.click(box.x + 700, box.y + 600);
  await draw(A, box, [[70, 120], [300, 120], [300, 230], [70, 230], [70, 125]]);
  const sf = await selBox(A);
  const knob2 = await A.locator(".lasso-select:visible .lasso-select__rotate").boundingBox();
  const r2 = center(knob2)[1] - center(sf)[1];
  await A.mouse.move(...center(knob2)); await A.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const a = Math.PI / 2 + (i / 6) * (Math.PI / 6);
    await A.mouse.move(center(sf)[0] + r2 * Math.cos(a), center(sf)[1] + r2 * Math.sin(a));
  }
  await A.mouse.up();
  await A.waitForTimeout(200);
  const sf2 = await selBox(A);
  check(sf2.height > sf.height * 1.3 && sf2.width > sf2.height, "free rotation (strokes only) tilts the strokes", [sf.width, sf.height, sf2.width, sf2.height]);
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(200);
  await A.mouse.click(box.x + 700, box.y + 600);

  // ── 圖片上下順序 ──
  await A.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles([
    { name: "紅.png", mimeType: "image/png", buffer: await makePng(A, "#dc2626") },
    { name: "綠.png", mimeType: "image/png", buffer: await makePng(A, "#16a34a") },
  ]);
  await A.locator('.page[data-page-number="1"] .note-image').nth(1).waitFor();
  await A.waitForTimeout(300);
  const boxes = await Promise.all([0, 1].map((i) => A.locator('.page[data-page-number="1"] .note-image').nth(i).boundingBox()));
  // 兩張錯開 18pt 重疊；取重疊區域的中心
  const ox = (Math.max(boxes[0].x, boxes[1].x) + Math.min(boxes[0].x + boxes[0].width, boxes[1].x + boxes[1].width)) / 2;
  const oy = (Math.max(boxes[0].y, boxes[1].y) + Math.min(boxes[0].y + boxes[0].height, boxes[1].y + boxes[1].height)) / 2;
  check(await colorAt(A, ox, oy) === "green", "the later image is on top", await colorAt(A, ox, oy));
  await A.locator(".image-select:visible").getByRole("button", { name: "移到最下層" }).click();
  await A.waitForTimeout(300);
  check(await colorAt(A, ox, oy) === "red", "置底: the selected image goes under", await colorAt(A, ox, oy));
  await A.keyboard.press("Control+BracketRight");
  await A.waitForTimeout(300);
  check(await colorAt(A, ox, oy) === "green", "Ctrl+] moves it up one layer", await colorAt(A, ox, oy));
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(300);
  check(await colorAt(A, ox, oy) === "red", "undo the reorder", await colorAt(A, ox, oy));

  // 圖片「複製」→ 貼上：多一張，在最上層
  await A.locator(".image-select:visible").getByRole("button", { name: "複製" }).click();
  await A.getByRole("button", { name: /^貼上複製的內容/ }).click();
  await A.waitForTimeout(400);
  check(await A.locator('.page[data-page-number="1"] .note-image').count() === 3, "copy + paste an image adds a third image");
  check(await A.locator(".lasso-select:visible").count() === 1, "the pasted image is selected");
  await A.keyboard.press("Control+z");
  await A.waitForTimeout(300);

  // 套索選取兩張圖片：旋轉一定吸附 90 度；縮放
  await A.mouse.click(box.x + 20, box.y + 20);
  const minX = Math.min(boxes[0].x, boxes[1].x) - box.x - 20, minY = Math.min(boxes[0].y, boxes[1].y) - box.y - 20;
  const maxX = Math.max(boxes[0].x + boxes[0].width, boxes[1].x + boxes[1].width) - box.x + 20, maxY = Math.max(boxes[0].y + boxes[0].height, boxes[1].y + boxes[1].height) - box.y + 20;
  await draw(A, box, [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY + 5]]);
  check(await A.locator(".lasso-select [data-order]:visible").count() === 2, "order buttons shown when the lasso has images");
  const si = await selBox(A);
  const knob3 = await A.locator(".lasso-select:visible .lasso-select__rotate").boundingBox();
  const r3 = center(knob3)[1] - center(si)[1];
  await A.mouse.move(...center(knob3)); await A.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const a = Math.PI / 2 + (i / 6) * (Math.PI / 6); // 只轉 30 度：有圖片時吸附回 0 度
    await A.mouse.move(center(si)[0] + r3 * Math.cos(a), center(si)[1] + r3 * Math.sin(a));
  }
  await A.mouse.up();
  await A.waitForTimeout(200);
  const si2 = await selBox(A);
  check(Math.abs(si2.width - si.width) < 3 && Math.abs(si2.height - si.height) < 3, "with images, rotation snaps to 90° (30° → 0°)", [si.width, si2.width]);
  const h2 = await A.locator(".lasso-select:visible .lasso-select__handle").boundingBox();
  await dragTo(A, center(h2), [center(h2)[0] - 60, center(h2)[1] - 60]);
  const si3 = await selBox(A);
  check(si3.width < si.width * 0.85, "scale handle shrinks the images", [si.width, si3.width]);
  const small = await A.locator('.page[data-page-number="1"] .note-image').first().boundingBox();
  check(small.width < boxes[0].width * 0.9, "image itself is smaller", [boxes[0].width, small.width]);

  check(errors.length === 0, "no page errors (desktop)", errors);
  await ctx.close();
}

async function ipad(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, isMobile: false, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
  const pen = (type, x, y, force = 0.6) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, pointerType: "pen", force, clickCount: 1 });
  const scrollTop = () => page.locator(".reader__scroll").evaluate((el) => el.scrollTop);
  await page.goto(env.BASE + "/");
  await page.getByRole("button", { name: "空白" }).click();
  await waitCount(page, 1);
  await page.getByLabel("只用觸控筆").check();
  await page.keyboard.press("p");
  await page.waitForTimeout(200);
  const pg = await page.locator('.page[data-page-number="1"]').boundingBox();
  const sx = pg.x + 100, sy = pg.y + 160;
  await pen("mousePressed", sx, sy);
  for (let i = 1; i <= 10; i++) await pen("mouseMoved", sx + i * 15, sy);
  await pen("mouseReleased", sx + 150, sy, 0);
  await page.keyboard.press("s");
  await page.waitForTimeout(200);
  const loop = [[sx - 30, sy - 40], [sx + 190, sy - 40], [sx + 190, sy + 40], [sx - 30, sy + 40], [sx - 30, sy - 35]];
  await pen("mousePressed", ...loop[0]);
  for (const [x, y] of loop.slice(1)) for (let k = 1; k <= 4; k++) await pen("mouseMoved", x, y);
  await pen("mouseReleased", ...loop[loop.length - 1], 0);
  await page.waitForTimeout(200);
  const lb = await selBox(page);
  check(!!lb, "iPad: Apple Pencil lasso selects the stroke");
  const hb = await page.locator(".lasso-select:visible .lasso-select__handle").boundingBox();
  check(hb.width >= 24, "iPad: scale handle is touch-sized", hb.width);

  // 手指拉縮放把手（「只用觸控筆」時也不會捲動）
  const top0 = await scrollTop();
  const [hx, hy] = center(hb);
  await touch("touchStart", [[hx, hy]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[hx + i * 10, hy + i * 10]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  const lb2 = await selBox(page);
  check(lb2.width > lb.width * 1.2 && Math.abs((await scrollTop()) - top0) < 2, "iPad: finger drags the scale handle without scrolling", [lb.width, lb2.width, (await scrollTop()) - top0]);

  // 手指拉旋轉把手
  const kb = await page.locator(".lasso-select:visible .lasso-select__rotate").boundingBox();
  const [kx, ky] = center(kb);
  const [ccx, ccy] = center(lb2);
  const rr = ky - ccy;
  await touch("touchStart", [[kx, ky]]);
  for (let i = 1; i <= 12; i++) {
    const a = Math.PI / 2 + (i / 12) * (Math.PI / 2);
    await touch("touchMove", [[ccx + rr * Math.cos(a) + 3, ccy + rr * Math.sin(a)]]);
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  const lb3 = await selBox(page);
  check(lb3.height > lb3.width && Math.abs((await scrollTop()) - top0) < 2, "iPad: finger turns the rotate handle", [lb3.width, lb3.height]);

  // 「複製」按鈕 → 工具列「貼上」（沒有鍵盤）
  await page.locator(".lasso-select:visible").getByRole("button", { name: "複製" }).click();
  const before = await inkIn(page, [0, 0, pg.width, pg.height]);
  await page.getByRole("button", { name: /^貼上複製的內容/ }).click();
  await page.waitForTimeout(300);
  check((await inkIn(page, [0, 0, pg.width, pg.height])) > before * 1.6, "iPad: copy button + toolbar paste button", [before, await inkIn(page, [0, 0, pg.width, pg.height])]);

  check(errors.length === 0, "no page errors (iPad)", errors);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  await desktop(browser);
  await ipad(browser);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
