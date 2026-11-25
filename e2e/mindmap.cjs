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
/** 匯出：圖片格式（PNG、SVG、PDF）會先開選項視窗，按「匯出」才下載 */
async function download(p, label, opts = {}) {
  const image = ["PNG 圖片", "SVG 圖片", "PDF"].includes(label);
  const done = p.waitForEvent("download");
  await p.getByLabel("匯出").selectOption({ label });
  if (image) {
    const dlg = p.getByRole("dialog", { name: `匯出 ${label}` });
    if (opts.transparent) await dlg.getByLabel("透明背景").check();
    if (opts.selection) await dlg.getByLabel(/只匯出選取的/).check();
    await dlg.getByRole("button", { name: "匯出" }).click();
  }
  const d = await done;
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
  check((await texts(page)).join() === "主題", "new map has a central topic", await texts(page));
  check((await selectedText(page)) === "主題", "central topic is selected");
  // 一開始是圓角方塊、文字「主題」；介面上方塊叫「元件」
  const rootShape = await node(page, "主題").evaluate((g) => { const r = g.querySelector("rect"); return r && { rx: r.getAttribute("rx"), fill: r.getAttribute("fill") }; });
  check(rootShape?.rx === "8", "new map starts with a rounded block", rootShape);
  const ui = await page.locator(".mm-toolbar").innerText();
  check(ui.includes("＋子元件") && !/子主題|同層主題/.test(ui), "blocks are called 元件 in the toolbar");
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
  check(JSON.stringify((await texts(page)).sort()) === JSON.stringify(["主題", "目標", "營收", "使用者", "時程", "風險"].sort()), "topics added with Tab / Enter", await texts(page));
  check((await outline(page)) === "# 主題\n- 目標\n  - 營收\n  - 使用者\n- 時程\n- 風險\n", "tree structure is right (markdown export)");

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

  // 編輯框在元件裡面；打長文字時元件即時變大、自動換行
  await node(page, "時間表").dblclick();
  const inside = async () => {
    const ta = await page.locator("textarea.mm-edit").boundingBox();
    const id = await page.evaluate(() => document.querySelector("[data-selected]").getAttribute("data-selected"));
    const nb = await page.locator(`.mm-nodes [data-node="${id}"] rect, .mm-nodes [data-node="${id}"] ellipse`).first().boundingBox();
    return { ok: ta.x >= nb.x - 1 && ta.y >= nb.y - 1 && ta.x + ta.width <= nb.x + nb.width + 1 && ta.y + ta.height <= nb.y + nb.height + 1, ta, nb };
  };
  let ins = await inside();
  check(ins.ok, "the edit box is inside the element", ins);
  const w0 = ins.nb.width;
  await page.keyboard.press("End");
  await page.keyboard.type("（第二季）");
  ins = await inside();
  check(ins.ok && ins.nb.width > w0, "the element grows while typing", [w0, ins.nb.width]);
  const h0 = ins.nb.height;
  await page.keyboard.type("：這是一段很長很長的說明文字，用來確認超過寬度時會自動換行 and wrap English words");
  ins = await inside();
  check(ins.ok && ins.nb.height > h0 * 1.8, "long text wraps: the element grows taller instead of wider", [h0, ins.nb.height, ins.nb.width]);
  const editW = ins.nb.width;
  const longId = await page.evaluate(() => document.querySelector("[data-selected]").getAttribute("data-selected"));
  await page.keyboard.press("Enter");
  const longNode = page.locator(`.mm-nodes [data-node="${longId}"]`);
  const tspans = await longNode.locator("tspan").count();
  const after = await longNode.locator("rect").first().boundingBox();
  check(tspans >= 3 && Math.abs(after.width - editW) < 1, "after editing the text is drawn on several lines, same size", [tspans, after.width, editW]);
  await page.keyboard.press("Control+z");
  check((await texts(page)).includes("時間表"), "undo restores the short text");

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
  // 相對主題的位置（選取的主題跑出畫面時畫面會自動捲動，所以不比螢幕座標）
  const posOf = async (t) => {
    const b = await node(page, t).boundingBox();
    const r = await node(page, "主題").boundingBox();
    return [Math.round(b.x - r.x), Math.round(b.y - r.y)];
  };
  const mdFree = await outline(page);
  const g0 = await posOf("目標"), k0 = await posOf("營收"), r0 = await posOf("Risk第二行");
  const [fx, fy] = await center(page, "目標");
  const goalId = await node(page, "目標").getAttribute("data-node");
  const edgeD = () => page.locator(`.mm-hits [data-edge="${goalId}"]`).getAttribute("d");
  const edge0 = await edgeD();
  // 找一個空白的落點（往下 160 px，碰到主題就再往下）
  let dropY = fy + 160;
  while (await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-node]"), [fx + 40, dropY])) dropY += 40;
  await page.mouse.move(fx, fy); await page.mouse.down();
  await page.mouse.move(fx + 10, fy + 10, { steps: 3 });
  await page.mouse.move(fx + 40, dropY, { steps: 10 });
  const edgeMid = await edgeD();
  const childMid = await posOf("營收");
  check(edgeMid !== edge0 && (await page.locator(".mm-ui rect[fill-opacity]:not(.mm-box)").count()) === 0, "while dragging, the connecting line follows (no drop hint on empty space)", [edge0, edgeMid]);
  check(childMid.join() === k0.join() && (await texts(page)).length === new Set(await texts(page)).size, "only the dragged element moves live; its children stay (no ghost)");
  await page.mouse.up();
  const g1 = await posOf("目標"), k1 = await posOf("營收"), r1 = await posOf("Risk第二行");
  const d = [g1[0] - g0[0], g1[1] - g0[1]];
  check(Math.abs(d[0] - 40) <= 2 && Math.abs(d[1] - (dropY - fy)) <= 2, "drop on empty space leaves the topic there", d);
  check(k1.join() === k0.join() && r1.join() === r0.join(), "children and others stay where they were", [k1, k0, r1, r0]);
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
  const [ox2, oy2] = await center(page, "主題");
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
  // 中心元件也可以拖，其他元件不動
  const goalBox0 = await node(page, "目標").boundingBox();
  const rootBox0 = await node(page, "主題").boundingBox();
  const [rcx, rcy] = await center(page, "主題");
  await page.mouse.move(rcx, rcy); await page.mouse.down();
  await page.mouse.move(rcx, rcy + 10, { steps: 3 });
  await page.mouse.move(rcx - 30, rcy + 50, { steps: 6 });
  await page.mouse.up();
  const goalBox1 = await node(page, "目標").boundingBox();
  const rootBox1 = await node(page, "主題").boundingBox();
  check(Math.round(rootBox1.y - rootBox0.y) === 50 && Math.round(goalBox1.y - goalBox0.y) === 0 && Math.round(goalBox1.x - goalBox0.x) === 0, "dragging the central element moves only it", [rootBox1.y - rootBox0.y, goalBox1.y - goalBox0.y]);
  await page.keyboard.press("Control+z");

  // ── 右鍵拖曳移動整張圖（不開選單）──
  const cbox = await page.locator(".mm-canvas").boundingBox();
  const emptyAt = async (m = 30) => {
    for (let y = cbox.y + m; y < cbox.y + cbox.height - m; y += 25)
      for (let x = cbox.x + m; x < cbox.x + cbox.width - m; x += 25)
        if (await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !!el?.closest(".mm-canvas") && !el.closest("[data-node],[data-edge],[data-toggle],[data-handle],.mm-menu,.mm-hint"); }, [x, y])) return [x, y];
    throw new Error("找不到空白處");
  };
  const tf = () => page.evaluate(() => document.querySelector(".mm-svg > g").getAttribute("transform"));
  let [ex, ey] = await emptyAt();
  const tf0 = await tf();
  await page.mouse.move(ex, ey); await page.mouse.down({ button: "right" });
  await page.mouse.move(ex + 60, ey + 40, { steps: 6 });
  await page.mouse.up({ button: "right" });
  check((await tf()) !== tf0 && (await page.locator(".mm-menu").count()) === 0, "right-drag pans the whole map without a menu", [tf0, await tf()]);
  const mdPan = await outline(page);

  // ── 右鍵點背景：畫布選單 ──
  [ex, ey] = await emptyAt();
  await page.mouse.click(ex, ey, { button: "right" });
  check(await page.locator(".mm-menu__title").textContent() === "畫布", "right-click background opens the canvas menu");
  const canvasItems = await page.getByRole("menuitem").allTextContents();
  check(["新增元件", "全選", "整張圖置中", "實際大小", "自動排列", "匯出 PNG"].every((t) => canvasItems.some((c) => c.includes(t))), "canvas menu has its own options", canvasItems);
  await page.getByRole("menuitem", { name: /實際大小/ }).click();
  check((await scale(page)) === 1 && (await page.locator(".mm-menu").count()) === 0, "canvas menu: actual size (100%)");
  [ex, ey] = await emptyAt();
  await page.mouse.click(ex, ey, { button: "right" });
  await page.getByRole("menuitem", { name: /全選/ }).click();
  const allCount = (await texts(page)).length;
  check((await page.locator("[data-multi]").count()) === allCount && (await page.locator("[data-selected-edge]").count()) === allCount - 1, "select all selects every topic and line", [await page.locator("[data-multi]").count(), allCount]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "置中" }).click();

  // ── 右鍵點主題：主題選單（形狀、線型、虛線）──
  const [tx3, ty3] = await center(page, "營收");
  await page.mouse.click(tx3, ty3, { button: "right" });
  check((await page.locator(".mm-menu__title").textContent()).includes("營收"), "right-click a topic opens the topic menu");
  check(await page.getByRole("menuitem", { name: /新增子元件/ }).count() === 1 && await page.getByRole("menuitem", { name: /刪除/ }).count() === 1, "topic menu has add / delete");
  await page.getByRole("group", { name: "形狀" }).getByRole("menuitemradio", { name: "橢圓" }).click();
  await page.getByRole("group", { name: "虛線" }).getByRole("menuitemradio", { name: "虛線" }).click();
  check(await page.locator(".mm-menu").count() === 1, "menu stays open while adjusting options");
  check(await node(page, "營收").locator("ellipse").count() === 1, "shape changed to ellipse");
  const revId = await node(page, "營收").getAttribute("data-node");
  check(await page.locator(".mm-edges path[stroke-dasharray]").count() === 1, "its line became dashed");
  await page.keyboard.press("Escape");
  check(await page.locator(".mm-menu").count() === 0, "Esc closes the menu");

  // ── 點線條選取、右鍵點線條：線條選單 ──
  const edgePoint = async (id) => page.evaluate((id) => {
    const p = document.querySelector(`.mm-hits [data-edge="${id}"]`);
    const pt = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM();
    return [pt.x * m.a + pt.y * m.c + m.e, pt.x * m.b + pt.y * m.d + m.f];
  }, id);
  const [lx, ly] = await edgePoint(revId);
  await page.mouse.click(lx, ly);
  check((await page.locator("[data-selected-edge]").count()) === 1 && (await page.locator("[data-multi]").count()) === 0, "clicking a line selects the line");
  await page.mouse.click(lx, ly, { button: "right" });
  check(await page.locator(".mm-menu__title").textContent() === "線條", "right-click a line opens the line menu");
  await page.getByRole("group", { name: "線型" }).getByRole("menuitemradio", { name: "直線" }).click();
  await page.getByRole("group", { name: "粗細" }).getByRole("menuitemradio", { name: "粗" }).click();
  const ld = await page.locator(`.mm-hits [data-edge="${revId}"]`).getAttribute("d");
  check(/^M[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+$/.test(ld), "line style changed to straight", ld);
  check(await page.locator('.mm-edges path[stroke-width="5"]').count() === 1, "line width changed to thick");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  check(!/^M[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+$/.test(await page.locator(`.mm-hits [data-edge="${revId}"]`).getAttribute("d")), "undo restores the line style");

  // ── 左鍵拖背景：框選主題與線條 ──
  const kb = await node(page, "營收").boundingBox();
  const tb = await node(page, "時間表").boundingBox();
  const x0 = Math.min(kb.x, tb.x) - 10, y0 = Math.min(kb.y, tb.y) - 10;
  const x1 = Math.max(kb.x + kb.width, tb.x + tb.width) + 10, y1 = Math.max(kb.y + kb.height, tb.y + tb.height) + 10;
  await page.keyboard.press("Escape");
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  check(await page.locator(".mm-box").count() === 1, "left-drag on background draws a selection box");
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
  const boxed = await page.locator("[data-multi]").count();
  check(boxed === 2 && (await page.locator(".mm-box").count()) === 0, "selection box selects the topics inside", boxed);
  check((await page.locator("[data-selected-edge]").count()) >= 1, "…and the lines crossing it", await page.locator("[data-selected-edge]").count());
  // 多選一起拖
  const a0 = await posOf("營收"), b0 = await posOf("時間表");
  const [mx3, my3] = await center(page, "營收");
  await page.mouse.move(mx3, my3); await page.mouse.down();
  await page.mouse.move(mx3 + 10, my3 + 10, { steps: 3 });
  await page.mouse.move(mx3 + 60, my3 + 120, { steps: 8 });
  await page.mouse.up();
  const a1 = await posOf("營收"), b1 = await posOf("時間表");
  check(a1[0] - a0[0] === b1[0] - b0[0] && a1[1] - a0[1] === b1[1] - b0[1] && a1[0] !== a0[0], "multiple selected topics move together", [a0, a1, b0, b1]);
  check((await outline(page)) === mdPan, "moving a selection never changes the tree");
  // 右鍵點多選中的主題：一次改全部
  await page.mouse.click(...(await center(page, "營收")), { button: "right" });
  check(await page.locator(".mm-menu__title").textContent() === "2 個元件", "right-click inside a multi-selection keeps it", await page.locator(".mm-menu__title").textContent());
  await page.getByRole("menuitem", { name: "排列選取的 2 個元件" }).click();
  check((await posOf("營收")).join() === a0.join() && (await posOf("時間表")).join() === b0.join(), "menu: back to auto layout position (both)");
  await page.keyboard.press("Escape");

  // ── 元件最小大小 ──
  const minScale = await scale(page);
  const minOk = await page.$$eval(".mm-nodes [data-node]", (els) => els.map((g) => g.getBBox()).every((b) => b.width >= 119 && b.height >= 43));
  check(minOk, "every element is at least the minimum size (120×44)", minScale);

  // ── 右鍵點背景新增 = 獨立元件（不連線）；從圓點拉線連接；刪掉線條 ──
  const mdBeforeFloat = await outline(page);
  const edgeCount = async () => page.locator(".mm-edges path").count();
  const e0 = await edgeCount();
  [ex, ey] = await emptyAt(140);
  await page.mouse.click(ex, ey, { button: "right" });
  await page.getByRole("menuitem", { name: "新增元件" }).click();
  await typeTopic(page, "獨立");
  await page.keyboard.press("Enter");
  const [flx, fly] = await center(page, "獨立");
  check((await edgeCount()) === e0 && Math.hypot(flx - ex, fly - ey) < 30, "background menu adds a standalone element (no line) where you clicked", [flx - ex, fly - ey]);
  check((await outline(page)).startsWith(mdBeforeFloat.trimEnd()) && (await outline(page)).includes("# 獨立"), "standalone element is not part of the tree");
  // 右鍵點元件新增的子元件會自動連線（前面的 Tab／選單已測）；這裡從「時間表」的圓點拉線到「獨立」
  await node(page, "時間表").click();
  check(await page.locator("[data-handle]").count() === 1, "a connected element shows one link handle (away from its incoming line)");
  const handleAt = (side) => page.evaluate((side) => {
    const r = document.querySelector(side ? `[data-handle][data-side="${side}"] circle:last-child` : "[data-handle] circle:last-child").getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, side);
  const fPos0 = await posOf("獨立");
  let [hdx, hdy] = await handleAt(null);
  await page.mouse.move(hdx, hdy); await page.mouse.down();
  await page.mouse.move((hdx + flx) / 2, (hdy + fly) / 2, { steps: 4 });
  check(await page.locator(".mm-link path").count() === 1, "dragging from a handle draws a line preview");
  await page.mouse.move(flx, fly, { steps: 4 });
  check(await page.locator('.mm-link[data-link-ok="true"]').count() === 1, "hovering a valid element highlights it");
  await page.mouse.up();
  const mdLinked = await outline(page);
  check((await edgeCount()) === e0 + 1 && mdLinked === mdBeforeFloat + "\n# 獨立\n", "releasing on an element adds a line without changing anyone's parent", mdLinked);
  check((await posOf("獨立")).join() === fPos0.join(), "connected element stays where it was", [fPos0, await posOf("獨立")]);
  // 可以連到中心元件；已經有線的兩個元件不能再連
  await node(page, "獨立").click();
  check(await page.locator("[data-handle]").count() === 2, "a standalone element has handles on both sides");
  const dragLink = async (to) => {
    const [hx, hy] = await handleAt(null);
    const [tx, ty] = await center(page, to);
    await page.mouse.move(hx, hy); await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    const ok = await page.locator(".mm-link").getAttribute("data-link-ok");
    await page.mouse.up();
    return ok;
  };
  check((await dragLink("時間表")) === "false" && (await edgeCount()) === e0 + 1, "linking two elements that already have a line is not allowed");
  await node(page, "獨立").click();
  check((await dragLink("主題")) === "true" && (await edgeCount()) === e0 + 2, "an element can be linked to the central element");
  check((await outline(page)) === mdLinked, "…still without changing the tree");
  // 點手拉的線按 Delete：只刪那條線
  const linkIds = await page.$$eval('.mm-hits [data-edge^="link:"]', (els) => els.map((e) => e.getAttribute("data-edge")));
  check(linkIds.length === 2, "hand-drawn lines are listed as lines", linkIds);
  await page.mouse.click(...(await edgePoint(linkIds[1])));
  await page.mouse.click(...(await edgePoint(linkIds[1])), { button: "right" });
  check(await page.locator(".mm-menu__title").textContent() === "線條", "right-click a hand-drawn line opens the line menu");
  await page.getByRole("group", { name: "虛線" }).getByRole("menuitemradio", { name: "虛線" }).click();
  check(await page.locator(`.mm-hits [data-edge="${linkIds[1]}"]`).count() === 1 && await page.locator(".mm-edges path[stroke-dasharray]").count() >= 1, "hand-drawn line style can be changed");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Delete");
  check((await edgeCount()) === e0 + 1 && (await texts(page)).includes("獨立"), "Delete on a hand-drawn line removes only that line");
  await page.mouse.click(...(await edgePoint(linkIds[0])));
  await page.keyboard.press("Delete");
  check((await edgeCount()) === e0 && (await outline(page)) === mdLinked, "all lines removed, tree unchanged");
  check((await posOf("獨立")).join() === fPos0.join(), "element stays in place");

  // 拖動獨立元件（已選取）
  const [glx, gly] = await center(page, "獨立");
  await page.mouse.move(glx, gly); await page.mouse.down();
  await page.mouse.move(glx + 10, gly + 10, { steps: 3 });
  await page.mouse.move(glx + 40, gly + 30, { steps: 5 });
  await page.mouse.up();
  const fPos1 = await posOf("獨立");
  check(fPos1[0] !== fPos0[0] && (await edgeCount()) === e0, "standalone element can be dragged freely", [fPos0, fPos1]);
  await page.keyboard.press("Control+z");
  check((await posOf("獨立")).join() === fPos0.join(), "undo moves it back");

  // ── 排列選取的元件：有連線的回到自動位置，獨立元件排成整齊的一列 ──
  await page.keyboard.press("Escape");
  [ex, ey] = await emptyAt(140);
  await page.mouse.click(ex, ey, { button: "right" });
  await page.getByRole("menuitem", { name: "新增元件" }).click();
  await typeTopic(page, "獨立二");
  await page.keyboard.press("Enter");
  const tl0 = await posOf("時間表");
  const [t1x, t1y] = await center(page, "時間表");
  await page.keyboard.press("Escape");
  await page.mouse.move(t1x, t1y); await page.mouse.down();
  await page.mouse.move(t1x + 10, t1y + 10, { steps: 3 });
  await page.mouse.move(t1x + 70, t1y + 90, { steps: 6 });
  // 放到空白處（不要蓋住別的元件）
  const [ox, oy] = await emptyAt(160);
  await page.mouse.move(ox, oy, { steps: 6 });
  await page.mouse.up();
  check((await posOf("時間表")).join() !== tl0.join(), "moved an element away before arranging");
  await page.getByRole("button", { name: "置中" }).click();
  await node(page, "時間表").click();
  await node(page, "獨立").click({ modifiers: ["Shift"] });
  await node(page, "獨立二").click({ modifiers: ["Shift"] });
  check((await page.locator("[data-multi]").count()) === 3, "three elements selected");
  await page.getByRole("button", { name: "自動排列" }).click();
  const fa = await node(page, "獨立").boundingBox(), fb = await node(page, "獨立二").boundingBox();
  const [top, bottom] = fa.y < fb.y ? [fa, fb] : [fb, fa];
  check((await posOf("時間表")).join() === tl0.join(), "arranging the selection puts the connected element back", [await posOf("時間表"), tl0]);
  check(Math.abs(fa.x - fb.x) < 1 && bottom.y >= top.y + top.height, "…and lines up every selected standalone element in a column", [fa, fb]);
  await page.keyboard.press("Control+z");
  check((await posOf("時間表")).join() !== tl0.join() && (await posOf("獨立")).join() === fPos0.join(), "undo restores everything in one step");
  await page.keyboard.press("Control+z");
  check((await posOf("時間表")).join() === tl0.join(), "undo the drag too");
  await page.keyboard.press("Escape");
  await node(page, "獨立二").click();
  await page.keyboard.press("Delete");
  await node(page, "獨立").click();
  await page.keyboard.press("Delete");
  { const mdEnd = await outline(page); check(mdEnd === mdBeforeFloat, "deleting the standalone element leaves the tree as before", [mdEnd, mdBeforeFloat]); }

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
  await node(page, "主題").click();
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
  check(svgText.startsWith("<svg") && svgText.includes("主題") && !svgText.includes("data-selected"), "export SVG (without the selection box)");
  // 透明背景：PNG 角落是透明的；SVG 沒有背景
  const pngT = await download(page, "PNG 圖片", { transparent: true });
  const corner = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
    c.drawImage(bmp, 0, 0);
    return [c.getImageData(1, 1, 1, 1).data[3], c.getImageData(0, 0, 1, 1).data[3]];
  }, pngT.data.toString("base64"));
  const cornerOpaque = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
    c.drawImage(bmp, 0, 0);
    return c.getImageData(1, 1, 1, 1).data[3];
  }, png.data.toString("base64"));
  check(corner[0] === 0 && cornerOpaque === 255, "PNG with transparent background", [corner, cornerOpaque]);
  const svgT = (await download(page, "SVG 圖片", { transparent: true })).data.toString("utf8");
  check(svgT.split("<rect").length < svgText.split("<rect").length && svgT.includes("主題"), "SVG with transparent background has no background rect");
  // 只匯出選取的元件
  await node(page, "目標").click();
  const svgSel = (await download(page, "SVG 圖片", { selection: true })).data.toString("utf8");
  check(svgSel.includes("目標") && !svgSel.includes("主題") && !svgSel.includes("<path"), "export only the selected element", svgSel.length);
  const dlgCheck = page.getByLabel("匯出");
  await page.keyboard.press("Escape");
  await dlgCheck.selectOption({ label: "PNG 圖片" });
  check(await page.getByRole("dialog", { name: "匯出 PNG 圖片" }).getByLabel(/只匯出選取的/).isDisabled(), "selection-only is disabled when nothing is selected");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  check(await page.getByRole("dialog").count() === 0, "cancel closes the export dialog");
  const pdf = await download(page, "PDF");
  check(pdf.name.endsWith(".pdf") && pdf.data.subarray(0, 5).toString() === "%PDF-" && pdf.data.length > 5000, "export PDF", [pdf.name, pdf.data.length]);
  const opml = await download(page, "OPML 大綱（.opml）");
  check(opml.name.endsWith(".opml") && opml.data.toString("utf8").includes('<opml version="2.0">'), "export OPML", opml.name);
  const fm = await download(page, "FreeMind（.mm）");
  check(fm.name.endsWith(".mm") && fm.data.toString("utf8").startsWith('<map version="1.0.1">'), "export FreeMind", fm.name);
  const mdFile = await download(page, "Markdown 大綱");
  const file = await download(page, "心智圖檔（.gugamap）");
  check(file.name.endsWith(".gugamap") && JSON.parse(file.data.toString("utf8")).format === "gugamap", "export .gugamap", file.name);
  const mdBefore = await outline(page);

  // ── 自動儲存：重新整理後還在 ──
  await page.getByLabel("心智圖標題").fill("專案規劃");
  await page.waitForTimeout(600);
  await page.reload();
  await page.getByRole("button", { name: /^專案規劃/ }).waitFor();
  const meta = await page.locator(".mm-list__meta").first().textContent();
  check(meta.startsWith(`${count} 個元件`), "list shows the saved map with topic count", meta);
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
  // 其他格式開成新的心智圖：內容（大綱）一樣
  for (const [f, mime, label] of [[fm, "application/xml", "FreeMind"], [opml, "text/x-opml", "OPML"], [mdFile, "text/markdown", "Markdown"]]) {
    await page.getByRole("button", { name: "回到心智圖清單" }).click();
    await page.locator('input[aria-label="選擇心智圖檔"]').setInputFiles({ name: f.name, mimeType: mime, buffer: f.data });
    await page.locator(".mm-canvas").waitFor();
    check((await outline(page)) === mdBefore, `opening the ${label} file gives the same outline`, await outline(page));
  }
  await page.getByRole("button", { name: "回到心智圖清單" }).click();
  await page.locator('input[aria-label="選擇心智圖檔"]').setInputFiles({ name: "其他.txt", mimeType: "text/plain", buffer: Buffer.from("讀書\n\t數學\n\t英文\n") });
  await page.locator(".mm-canvas").waitFor();
  check((await outline(page)) === "# 讀書\n- 數學\n- 英文\n", "opening an indented text file", await outline(page));
  await page.getByRole("button", { name: "回到心智圖清單" }).click();
  await page.locator('input[aria-label="選擇心智圖檔"]').setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") });
  check((await page.getByRole("alert").textContent()).startsWith("不支援這種檔案"), "unsupported file shows which formats work");
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
  await tp.getByRole("button", { name: "＋子元件" }).click(); await typeTopic(tp, "甲"); await tp.keyboard.press("Enter");
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
  // 長按 = 操作選單（沒有右鍵）
  await touch("touchStart", [await center(tp, "乙")]);
  await tp.waitForTimeout(800);
  await touch("touchEnd", []);
  check((await tp.locator(".mm-menu__title").textContent()).includes("乙"), "long press opens the topic menu");
  await tp.getByRole("menuitem", { name: /編輯文字/ }).click();
  check(await tp.locator("textarea.mm-edit").count() === 1, "menu item works with touch (edit)");
  await tp.keyboard.press("Escape");
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
