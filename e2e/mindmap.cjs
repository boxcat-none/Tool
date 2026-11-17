// 心智圖（獨立開發）：新增、鍵盤編輯、拖曳換位置、收合、復原、貼上大綱、結構與樣式、自動儲存、匯出與開啟檔案、iPad 觸控、iPhone 版面
const fs = require("fs");
const env = require("./lib/env.cjs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const OUT = env.out("mindmap");

const texts = (p) => p.$$eval(".mm-nodes [data-node]", (els) => els.map((g) => g.querySelector("text").textContent.trim()));
/** 文字剛好是 text 的節點（多行節點的文字會接在一起比對） */
const node = (p, text) => p.locator(".mm-nodes [data-node]").filter({ has: p.locator("css=text", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).first();
const center = async (p, text) => { const b = await node(p, text).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const selectedText = (p) => p.evaluate(() => {
  const id = document.querySelector("[data-selected]")?.getAttribute("data-selected");
  return id ? document.querySelector(`.mm-nodes [data-node="${id}"] text`).textContent.trim() : null;
});
const scale = (p) => p.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.querySelector(".mm-svg > g").getAttribute("transform"))[1]));
async function typeTopic(p, text) {
  await p.locator("textarea.mm-edit").waitFor();
  await p.keyboard.type(text);
}
async function download(p, label) {
  const [d] = await Promise.all([p.waitForEvent("download"), p.getByLabel("匯出").selectOption({ label })]);
  const file = `${OUT}/${d.suggestedFilename()}`;
  await d.saveAs(file);
  return { name: d.suggestedFilename(), data: fs.readFileSync(file) };
}
/** Markdown 大綱（從匯出取得，用來檢查樹的結構） */
const outline = async (p) => (await download(p, "Markdown 大綱")).data.toString("utf8");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(env.BASE + "/#mindmap");

  // ── 新增 ──
  await page.getByRole("button", { name: "新增心智圖" }).click();
  await page.locator(".mm-canvas").waitFor();
  check((await texts(page)).join() === "中心主題", "new map has a central topic", await texts(page));
  check((await selectedText(page)) === "中心主題", "central topic is selected");
  check(await page.getByLabel("樣式").inputValue() === "node", "default style is node cards (E)");

  // ── 鍵盤：Tab 子主題、Enter 同層、編輯中 Tab 連續新增 ──
  await page.keyboard.press("Tab"); await typeTopic(page, "目標");
  await page.keyboard.press("Tab"); await typeTopic(page, "營收");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); await typeTopic(page, "使用者");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowLeft");
  check((await selectedText(page)) === "目標", "arrow left moves to parent (logic side)", await selectedText(page));
  await page.keyboard.press("Enter"); await typeTopic(page, "時程"); await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); await typeTopic(page, "風險"); await page.keyboard.press("Enter");
  check(JSON.stringify((await texts(page)).sort()) === JSON.stringify(["中心主題", "目標", "營收", "使用者", "時程", "風險"].sort()), "topics added with Tab / Enter", await texts(page));
  check((await outline(page)) === "# 中心主題\n- 目標\n  - 營收\n  - 使用者\n- 時程\n- 風險\n", "tree structure is right (markdown export)");

  // 直接打字取代、Shift+Enter 換行、Esc 取消
  await node(page, "風險").click();
  await page.keyboard.type("R");
  await page.keyboard.type("isk");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("第二行");
  await page.keyboard.press("Enter");
  check((await texts(page)).includes("Risk\n第二行".replace("\n", "")) || (await page.locator(".mm-nodes tspan", { hasText: "第二行" }).count()) === 1, "typing replaces text, Shift+Enter adds a line");
  await page.keyboard.press("F2");
  await page.keyboard.type("不要");
  await page.keyboard.press("Escape");
  check(!(await texts(page)).some((t) => t.includes("不要")), "Esc cancels editing");

  // 點兩下編輯
  await node(page, "時程").dblclick();
  await page.locator("textarea.mm-edit").fill("時間表");
  await page.keyboard.press("Enter");
  check((await texts(page)).includes("時間表"), "double click edits the topic");

  // ── 拖曳：放到別的節點中間 = 變成子主題 ──
  const [sx, sy] = await center(page, "時間表");
  const [tx, ty] = await center(page, "目標");
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx + 10, sy + 10, { steps: 3 });
  await page.mouse.move(tx, ty, { steps: 10 });
  check((await page.locator(".mm-ui rect[fill-opacity]").count()) === 1, "drop hint shows while dragging over a topic");
  await page.mouse.up();
  let md = await outline(page);
  check(md.includes("- 目標\n  - 營收\n  - 使用者\n  - 時間表\n"), "drag onto a topic makes it a child", md);
  // 放在節點靠上 = 插在前面
  const [ux, uy] = await center(page, "營收");
  const ub = await node(page, "營收").boundingBox();
  const [vx, vy] = await center(page, "時間表");
  await page.mouse.move(vx, vy); await page.mouse.down();
  await page.mouse.move(vx + 10, vy - 10, { steps: 3 });
  await page.mouse.move(ux, ub.y + 2, { steps: 10 });
  await page.mouse.up();
  md = await outline(page);
  check(md.includes("- 目標\n  - 時間表\n  - 營收\n  - 使用者\n"), "drop on the upper part inserts before", md);
  // 不能拖到自己的子孫上
  const [gx, gy] = await center(page, "目標");
  const [hx, hy] = await center(page, "營收");
  await page.mouse.move(gx, gy); await page.mouse.down();
  await page.mouse.move(gx + 10, gy, { steps: 3 });
  await page.mouse.move(hx, hy, { steps: 10 });
  await page.mouse.up();
  check((await outline(page)) === md, "cannot drop a topic into its own subtree");

  // ── 復原、重做 ──
  await page.keyboard.press("Control+z");
  check((await outline(page)).includes("- 目標\n  - 營收\n  - 使用者\n  - 時間表\n"), "undo restores the previous position");
  await page.keyboard.press("Control+y");
  check((await outline(page)) === md, "redo applies it again");

  // ── 自由拖動：拖到空白處就停在那裡，子主題一起移動；自動排列回到原位 ──
  // 相對中心主題的位置（選取的主題跑出畫面時畫面會自動捲動，所以不比螢幕座標）
  const posOf = async (t) => {
    const b = await node(page, t).boundingBox();
    const r = await node(page, "中心主題").boundingBox();
    return [Math.round(b.x - r.x), Math.round(b.y - r.y)];
  };
  const mdFree = await outline(page);
  const g0 = await posOf("目標"), k0 = await posOf("營收"), r0 = await posOf("Risk第二行");
  const [fx, fy] = await center(page, "目標");
  // 找一個空白的落點（往下 160 px，碰到主題就再往下）
  let dropY = fy + 160;
  while (await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-node]"), [fx + 40, dropY])) dropY += 40;
  await page.mouse.move(fx, fy); await page.mouse.down();
  await page.mouse.move(fx + 10, fy + 10, { steps: 3 });
  await page.mouse.move(fx + 40, dropY, { steps: 10 });
  check((await page.locator(".mm-ui [data-node]").count()) >= 3 && (await page.locator(".mm-ui rect[fill-opacity]").count()) === 0, "free drag previews the whole subtree, no drop hint");
  await page.mouse.up();
  const g1 = await posOf("目標"), k1 = await posOf("營收"), r1 = await posOf("Risk第二行");
  const d = [g1[0] - g0[0], g1[1] - g0[1]];
  check(Math.abs(d[0] - 40) <= 2 && Math.abs(d[1] - (dropY - fy)) <= 2, "drop on empty space leaves the topic there", d);
  check(Math.abs(k1[0] - k0[0] - d[0]) <= 1 && Math.abs(k1[1] - k0[1] - d[1]) <= 1 && r1.join() === r0.join(), "children move with it, others stay", [k1, k0, r1, r0]);
  // 拖到自己的子主題上：什麼都不改
  const [cx2, cy2] = await center(page, "目標");
  const [dx2, dy2] = await center(page, "營收");
  await page.mouse.move(cx2, cy2); await page.mouse.down();
  await page.mouse.move(cx2 + 10, cy2, { steps: 3 });
  await page.mouse.move(dx2, dy2, { steps: 10 });
  await page.mouse.up();
  check((await posOf("目標")).join() === g1.join() && (await outline(page)) === mdFree, "dropping onto its own child does nothing");
  check((await outline(page)) === mdFree, "free drag does not change the tree");
  // 按住 Shift 拖到別的主題上：也是自由放置，不換父節點
  const [sx2, sy2] = await center(page, "時間表");
  const [ox2, oy2] = await center(page, "中心主題");
  await page.keyboard.down("Shift");
  await page.mouse.move(sx2, sy2); await page.mouse.down();
  await page.mouse.move(sx2 + 10, sy2, { steps: 3 });
  await page.mouse.move(ox2, oy2, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  check((await outline(page)) === mdFree, "shift+drag onto a topic only moves it (no reparent)");
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "自動排列" }).click();
  check((await posOf("目標")).join() === g0.join() && (await posOf("營收")).join() === k0.join(), "auto arrange puts topics back", [await posOf("目標"), g0]);
  check(await page.getByRole("button", { name: "自動排列" }).isDisabled(), "auto arrange is disabled when nothing was moved");

  // ── 收合、展開 ──
  await node(page, "目標").click();
  await page.keyboard.press(" ");
  check(!(await texts(page)).includes("營收") && (await page.locator("[data-toggle] text").textContent()) === "+3", "space collapses (badge shows +3)", await texts(page));
  await page.locator("[data-toggle] text").click();
  check((await texts(page)).includes("營收"), "click the badge expands");

  // ── 刪除 ──
  await node(page, "使用者").click();
  await page.keyboard.press("Delete");
  check(!(await texts(page)).includes("使用者"), "Delete removes the topic");
  check((await selectedText(page)) === "營收", "selection moves to a sibling after delete", await selectedText(page));

  // ── 貼上大綱：依縮排建立 ──
  await node(page, "中心主題").click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "- 資源\n  - 人力\n  - 預算\n- 備註");
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  md = await outline(page);
  check(md.includes("- 資源\n  - 人力\n  - 預算\n- 備註\n"), "pasting indented text creates topics", md);

  // ── 顏色 ──
  await node(page, "資源").click();
  await page.getByLabel("分支顏色").selectOption({ label: "紅" });
  const portFill = await page.evaluate(() => [...document.querySelectorAll(".mm-ports circle")].map((c) => c.getAttribute("fill")));
  check(portFill.includes("#e03131"), "branch color applies to its ports", portFill);

  // ── 結構、樣式 ──
  const count = (await texts(page)).length;
  for (const s of ["logic", "org", "tree", "mindmap"]) {
    await page.getByLabel("結構").selectOption(s);
    const overlap = await page.evaluate(() => {
      const r = [...document.querySelectorAll(".mm-nodes [data-node]")].map((g) => g.querySelector("rect,path,ellipse,line").getBoundingClientRect());
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
        const a = r[i], b = r[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) return [i, j];
      }
      return null;
    });
    check((await texts(page)).length === count && overlap === null, `structure ${s}: all topics, no overlap`, overlap);
    await page.screenshot({ path: `${OUT}/structure-${s}.png` });
  }
  for (const t of ["rainbow", "minimal", "boxed", "sketch", "node"]) {
    await page.getByLabel("樣式").selectOption(t);
    const bg = await page.locator(".mm-canvas").evaluate((el) => getComputedStyle(el).backgroundColor);
    check((await texts(page)).length === count, `style ${t}: renders`, bg);
    await page.screenshot({ path: `${OUT}/style-${t}.png` });
  }
  check(await page.locator(".mm-canvas").evaluate((el) => getComputedStyle(el).backgroundColor) === "rgb(30, 27, 36)", "node style has the dark canvas");

  // ── 縮放 ──
  const s0 = await scale(page);
  const box = await page.locator(".mm-canvas").boundingBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -200); await page.keyboard.up("Control");
  check((await scale(page)) > s0 * 1.2, "ctrl+wheel zooms in", [s0, await scale(page)]);
  await page.getByRole("button", { name: "置中" }).click();

  // ── 匯出 ──
  const png = await download(page, "PNG 圖片");
  check(png.name.endsWith(".png") && png.data.subarray(1, 4).toString() === "PNG" && png.data.length > 5000, "export PNG", [png.name, png.data.length]);
  const svg = await download(page, "SVG 圖片");
  const svgText = svg.data.toString("utf8");
  check(svgText.startsWith("<svg") && svgText.includes("中心主題") && !svgText.includes("data-selected"), "export SVG (without the selection box)");
  const file = await download(page, "心智圖檔（.gugamap）");
  check(file.name.endsWith(".gugamap") && JSON.parse(file.data.toString("utf8")).format === "gugamap", "export .gugamap", file.name);
  const mdBefore = await outline(page);

  // ── 自動儲存：重新整理後還在 ──
  await page.getByLabel("心智圖標題").fill("專案規劃");
  await page.waitForTimeout(600);
  await page.reload();
  await page.getByRole("button", { name: /^專案規劃/ }).waitFor();
  const meta = await page.locator(".mm-list__meta").first().textContent();
  check(meta.startsWith(`${count} 個主題`), "list shows the saved map with topic count", meta);
  await page.getByRole("button", { name: /^專案規劃/ }).click();
  await page.locator(".mm-canvas").waitFor();
  check((await outline(page)) === mdBefore, "content is the same after reload");
  check(await page.getByLabel("結構").inputValue() === "mindmap" && await page.getByLabel("樣式").inputValue() === "node", "structure and style are saved");

  // ── 刪除後從檔案開回來 ──
  await page.getByRole("button", { name: "回到心智圖清單" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "刪除「專案規劃」" }).click();
  await page.getByText("還沒有心智圖").waitFor();
  check(true, "map deleted");
  await page.locator('input[aria-label="選擇心智圖檔"]').setInputFiles({ name: file.name, mimeType: "application/json", buffer: file.data });
  await page.locator(".mm-canvas").waitFor();
  check((await outline(page)) === mdBefore, "opening the .gugamap file restores the map");
  await page.getByRole("button", { name: "回到心智圖清單" }).click();
  await page.locator('input[aria-label="選擇心智圖檔"]').setInputFiles({ name: "壞.gugamap", mimeType: "application/json", buffer: Buffer.from("hello") });
  check(await page.getByRole("alert").textContent() === "這不是心智圖檔（.gugamap）", "a wrong file shows a clear error");
  check(errors.length === 0, "no page errors (desktop)", errors);
  await ctx.close();

  // ── iPad：手指點選、點兩下編輯、拖曳換位置、兩指縮放、拖曳空白處平移 ──
  const ipad = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, deviceScaleFactor: 2 });
  const tp = await ipad.newPage();
  tp.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ipad.newCDPSession(tp);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
  const tap = async ([x, y]) => { await touch("touchStart", [[x, y]]); await touch("touchEnd", []); };
  await tp.goto(env.BASE + "/#mindmap");
  await tp.getByRole("button", { name: "新增心智圖" }).click();
  await tp.locator(".mm-canvas").waitFor();
  await tp.getByRole("button", { name: "＋子主題" }).click(); await typeTopic(tp, "甲"); await tp.keyboard.press("Enter");
  await tp.getByRole("button", { name: "＋同層" }).click(); await typeTopic(tp, "乙"); await tp.keyboard.press("Enter");
  await tp.getByRole("button", { name: "＋同層" }).click(); await typeTopic(tp, "丙"); await tp.keyboard.press("Enter");
  await tp.getByRole("button", { name: "置中" }).click();
  await tap(await center(tp, "甲"));
  check((await selectedText(tp)) === "甲", "tap selects a topic", await selectedText(tp));
  const c = await center(tp, "乙");
  await tap(c); await tp.waitForTimeout(80); await tap(c);
  check(await tp.locator("textarea.mm-edit").count() === 1, "double tap edits");
  await tp.keyboard.press("Escape");
  const [ax, ay] = await center(tp, "丙");
  const [bx, by] = await center(tp, "甲");
  await touch("touchStart", [[ax, ay]]);
  for (let i = 1; i <= 12; i++) await touch("touchMove", [[ax + ((bx - ax) * i) / 12, ay + ((by - ay) * i) / 12]]);
  await touch("touchEnd", []);
  check((await outline(tp)).includes("- 甲\n  - 丙\n"), "finger drag moves a topic under another", await outline(tp));
  const before = await scale(tp);
  const cb = await tp.locator(".mm-canvas").boundingBox();
  const mx = cb.x + cb.width / 2, my = cb.y + cb.height / 2;
  await touch("touchStart", [[mx - 50, my], [mx + 50, my]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[mx - 50 - i * 15, my], [mx + 50 + i * 15, my]]);
  await touch("touchEnd", []);
  check((await scale(tp)) > before * 1.8, "two-finger pinch zooms", [before, await scale(tp)]);
  const t0 = await tp.evaluate(() => document.querySelector(".mm-svg > g").getAttribute("transform"));
  await touch("touchStart", [[cb.x + 30, cb.y + cb.height - 30]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[cb.x + 30 + i * 20, cb.y + cb.height - 30]]);
  await touch("touchEnd", []);
  const t1 = await tp.evaluate(() => document.querySelector(".mm-svg > g").getAttribute("transform"));
  check(t0 !== t1 && (await outline(tp)).includes("- 甲\n  - 丙\n"), "finger drag on empty area pans", [t0, t1]);
  await ipad.close();

  // ── iPhone：沒有橫向捲動，工具列可以左右滑 ──
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const pp = await phone.newPage();
  pp.on("pageerror", (e) => errors.push(e.message));
  await pp.goto(env.BASE + "/#mindmap");
  await pp.getByRole("button", { name: "新增心智圖" }).click();
  await pp.locator(".mm-canvas").waitFor();
  const layout = await pp.evaluate(() => ({
    page: document.documentElement.scrollWidth <= innerWidth,
    toolbarScrolls: (() => { const t = document.querySelector(".mm-toolbar"); return t.scrollWidth > t.clientWidth && getComputedStyle(t).overflowX === "auto"; })(),
    toolbarHeight: document.querySelector(".mm-toolbar").getBoundingClientRect().height,
    canvasHeight: document.querySelector(".mm-canvas").getBoundingClientRect().height,
  }));
  check(layout.page && layout.toolbarScrolls && layout.toolbarHeight < 60 && layout.canvasHeight > 600, "iPhone: no page scroll, one-row toolbar, big canvas", layout);
  await pp.screenshot({ path: `${OUT}/iphone.png` });
  await phone.close();

  check(errors.length === 0, "no page errors", errors);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FAIL exception " + e.stack); process.exit(1); });
