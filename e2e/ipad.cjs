// iPad 情境：觸控筆書寫不反白、兩指縮放、只用觸控筆時手指捲動
const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
const W2 = env.FIX; const shots = env.out("shots");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const inkPixels = (p, n) => p.evaluate((n) => { const c = document.querySelector(`.page[data-page-number="${n}"] .ink-layer__pen`); if (!c) return -1; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) k++; return k; }, n);
const percent = (p) => p.locator(".reader__percent").textContent().then((t) => parseInt(t));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, isMobile: false, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
  const pen = (type, x, y, force = 0.6) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, pointerType: "pen", force, clickCount: 1 });

  await page.goto(env.BASE + "/#reader");
  await page.locator(".drop input[type=file]").setInputFiles({ name: "目錄.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(W2, "目錄.pdf")) });
  await page.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 12");
  await page.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" });
  const box = await page.locator('.page[data-page-number="1"]').boundingBox();

  // ── 1. 觸控筆書寫：不會選取文字 ──
  await page.keyboard.press("p");
  check(await page.locator(".reader").evaluate((el) => el.classList.contains("reader--drawing")), "drawing mode class on reader");
  check(await page.locator(".textLayer").first().evaluate((el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect) === "none", "text not selectable while drawing");
  // 從標題文字上畫過去（之前在 iPad 會反白）
  const t = await page.evaluate(() => { const s = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find((e) => e.textContent.includes("Page 1")).getBoundingClientRect(); return { x: s.left, y: s.top + s.height / 2, w: s.width }; });
  await pen("mousePressed", t.x - 10, t.y, 0.2);
  for (let i = 1; i <= 20; i++) await pen("mouseMoved", t.x - 10 + (t.w + 40) * i / 20, t.y + Math.sin(i / 3) * 8, 0.2 + i * 0.035);
  await pen("mouseReleased", t.x + t.w + 30, t.y, 0);
  await page.waitForTimeout(200);
  check(await inkPixels(page, 1) > 100, "pen stroke drawn over text");
  check(await page.evaluate(() => getSelection().toString()) === "", "no text selected after pen stroke");
  check(await page.getByLabel("只用觸控筆").isChecked(), "first pen use auto-enables pen-only");
  await page.getByText("偵測到觸控筆").waitFor();
  check(true, "pen detected notice shown");

  // ── 2. 只用觸控筆：一指捲動、不畫線 ──
  check(await page.locator(".ink-input").first().evaluate((el) => el.style.touchAction) === "pan-x pan-y", "pen-only: fingers allowed to pan");
  const ink0 = await inkPixels(page, 1);
  const top0 = await page.locator(".reader__scroll").evaluate((el) => el.scrollTop);
  const cx = box.x + box.width / 2, cy = box.y + 600;
  await touch("touchStart", [[cx, cy]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[cx, cy - i * 30]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
  const top1 = await page.locator(".reader__scroll").evaluate((el) => el.scrollTop);
  check(top1 > top0 + 100, "pen-only: one finger scrolls the page", { before: top0, after: top1 });
  check(await inkPixels(page, 1) === ink0, "pen-only: finger did not draw");

  // ── 3. 兩指縮放（畫筆模式＋只用觸控筆）──
  await page.locator(".reader__scroll").evaluate((el) => (el.scrollTop = 0));
  const z0 = await percent(page);
  const mx = box.x + box.width / 2, my = 500;
  await touch("touchStart", [[mx - 60, my], [mx + 60, my]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[mx - 60 - i * 15, my], [mx + 60 + i * 15, my]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  const z1 = await percent(page);
  check(z1 > z0 * 1.5, "two-finger pinch zooms in (pen mode)", { before: z0, after: z1 });
  // 縮小
  await touch("touchStart", [[mx - 200, my], [mx + 200, my]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[mx - 200 + i * 15, my], [mx + 200 - i * 15, my]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  const z2 = await percent(page);
  check(z2 < z1 * 0.8, "two-finger pinch zooms out", { before: z1, after: z2 });
  check(await page.evaluate(() => visualViewport.scale) === 1, "browser page itself not zoomed (toolbar stays put)", await page.evaluate(() => visualViewport.scale));

  // ── 4. 不勾「只用觸控筆」：一指畫線；第二指放下時那一筆作廢並改成縮放 ──
  await page.getByLabel("只用觸控筆").uncheck();
  await page.locator(".reader__zoom").selectOption("page-width"); await page.waitForTimeout(400);
  await page.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" });
  const b2 = await page.locator('.page[data-page-number="1"]').boundingBox();
  const ink1 = await inkPixels(page, 1);
  await touch("touchStart", [[b2.x + 100, b2.y + 500]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[b2.x + 100 + i * 20, b2.y + 500 + i * 5]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(200);
  const ink2 = await inkPixels(page, 1);
  check(ink2 > ink1, "finger draws when pen-only is off", { before: ink1, after: ink2 });
  const z3 = await percent(page);
  await touch("touchStart", [[b2.x + 100, b2.y + 600]]);
  for (let i = 1; i <= 4; i++) await touch("touchMove", [[b2.x + 100 + i * 10, b2.y + 600]]);
  await touch("touchStart", [[b2.x + 140, b2.y + 600], [b2.x + 400, b2.y + 600]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[b2.x + 140 - i * 10, b2.y + 600], [b2.x + 400 + i * 10, b2.y + 600]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  check(await percent(page) > z3, "second finger turns stroke into pinch zoom", { before: z3, after: await percent(page) });
  await page.locator(".reader__zoom").selectOption("page-width"); await page.waitForTimeout(500);
  await page.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" }); await page.waitForTimeout(200);
  check(await inkPixels(page, 1) === ink2, "cancelled finger stroke left no ink", { expected: ink2, got: await inkPixels(page, 1) });

  // ── 5. 閱讀模式：兩指縮放也有效 ──
  await page.keyboard.press("v");
  const z4 = await percent(page);
  await touch("touchStart", [[mx - 60, my], [mx + 60, my]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[mx - 60 - i * 12, my], [mx + 60 + i * 12, my]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  check(await percent(page) > z4 * 1.3, "pinch zoom in read mode", { before: z4, after: await percent(page) });
  check(!(await page.locator(".reader").evaluate((el) => el.classList.contains("reader--drawing"))), "read mode: text selectable again");

  await page.screenshot({ path: path.join(shots, "ipad.png") });
  check(errors.length === 0, "no page errors", errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
