// iPad：「只用觸控筆」時，選取工具下手指按在圖片上拖曳圖片、按在空白處捲動；觸控筆也可以拖曳
const env = require("./lib/env.cjs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, isMobile: false, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
  const pen = (type, x, y, force = 0.6) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, pointerType: "pen", force, clickCount: 1 });
  const imgBox = () => page.locator('.page[data-page-number="1"] .note-image').first().boundingBox();
  const scrollTop = () => page.locator(".reader__scroll").evaluate((el) => el.scrollTop);

  await page.goto(env.BASE + "/");
  await page.getByRole("button", { name: "空白" }).click();
  await page.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 1");
  await page.getByRole("button", { name: "＋ 插入頁面" }).click();
  await page.getByRole("menuitem", { name: "空白" }).click();
  await page.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 2");
  await page.locator(".reader__page").fill("1"); await page.locator(".reader__page").press("Enter");
  await page.getByLabel("只用觸控筆").check();
  const b64 = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 300; const x = c.getContext("2d"); x.fillStyle = "#16a34a"; x.fillRect(0, 0, 400, 300); return c.toDataURL("image/png").split(",")[1]; });
  await page.locator('input[aria-label="選擇要插入的圖片"]').setInputFiles({ name: "圖.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
  await page.locator('.page[data-page-number="1"] .note-image').waitFor();
  check(await page.getByRole("radio", { name: /^選取（/ }).getAttribute("aria-checked") === "true", "select tool active");

  // 手指拖圖片
  let b = await imgBox();
  const s0 = await scrollTop();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await touch("touchStart", [[cx, cy]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[cx + i * 8, cy + i * 6]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  let a = await imgBox();
  check(Math.abs(a.x - b.x - 80) < 4 && Math.abs(a.y - b.y - 60) < 4 + Math.abs((await scrollTop()) - s0), "finger on image drags the image (pen-only on)", [a.x - b.x, a.y - b.y]);
  check(Math.abs((await scrollTop()) - s0) < 2, "…and does not scroll the page", [s0, await scrollTop()]);

  // 手指按空白處：捲動
  const page1 = await page.locator('.page[data-page-number="1"]').boundingBox();
  const ex = page1.x + 40, ey = Math.min(page1.y + page1.height - 60, 1200);
  const s1 = await scrollTop();
  await touch("touchStart", [[ex, ey]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[ex, ey - i * 30]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
  check((await scrollTop()) > s1 + 100, "finger on empty area scrolls (pen-only on)", [s1, await scrollTop()]);
  check(await page.locator(".image-select:visible").count() === 0, "tapping empty area deselects");

  // 觸控筆拖圖片
  await page.locator(".reader__scroll").evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(300);
  b = await imgBox();
  const px = b.x + b.width / 2, py = b.y + b.height / 2;
  await pen("mousePressed", px, py);
  for (let i = 1; i <= 10; i++) await pen("mouseMoved", px - i * 6, py + i * 4);
  await pen("mouseReleased", px - 60, py + 40, 0);
  await page.waitForTimeout(300);
  a = await imgBox();
  check(Math.abs(a.x - b.x + 60) < 4 && Math.abs(a.y - b.y - 40) < 4, "Apple Pencil drags the image", [a.x - b.x, a.y - b.y]);
  check(await page.evaluate(() => getSelection().toString()) === "", "no text selected");

  // 套索：用筆圈選筆跡，手指按在選取框裡拖曳（「只用觸控筆」時）
  await page.locator(".reader__scroll").evaluate((el) => (el.scrollTop = 0));
  await page.keyboard.press("p");
  await page.waitForTimeout(200);
  const pg = await page.locator('.page[data-page-number="1"]').boundingBox();
  const sx = pg.x + 80, sy = pg.y + 120;
  await pen("mousePressed", sx, sy);
  for (let i = 1; i <= 10; i++) await pen("mouseMoved", sx + i * 12, sy + Math.sin(i) * 6);
  await pen("mouseReleased", sx + 120, sy, 0);
  await page.keyboard.press("s");
  await page.waitForTimeout(200);
  const loop = [[sx - 30, sy - 30], [sx + 160, sy - 30], [sx + 160, sy + 40], [sx - 30, sy + 40], [sx - 30, sy - 25]];
  await pen("mousePressed", ...loop[0]);
  for (const [x, y] of loop.slice(1)) for (let k = 1; k <= 4; k++) await pen("mouseMoved", x, y);
  await pen("mouseReleased", ...loop[loop.length - 1], 0);
  await page.waitForTimeout(200);
  const lb = await page.locator(".lasso-select:visible").boundingBox();
  check(!!lb, "Apple Pencil lasso selects the stroke");
  const top0 = await scrollTop();
  await touch("touchStart", [[lb.x + lb.width / 2, lb.y + lb.height / 2]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[lb.x + lb.width / 2, lb.y + lb.height / 2 + i * 10]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  const lb2 = await page.locator(".lasso-select:visible").boundingBox();
  check(Math.abs(lb2.y - lb.y - 100) < 4 && Math.abs((await scrollTop()) - top0) < 2, "finger inside the lasso selection drags it (no scroll)", [lb2.y - lb.y, (await scrollTop()) - top0]);

  check(errors.length === 0, "no page errors", errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
