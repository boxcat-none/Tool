// W7：兩台「裝置」（不同的瀏覽器 context，各自的 IndexedDB）用邀請碼／回覆碼直接連線（WebRTC）並同步
const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const cjk = () => ({ name: "中文.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(env.FIX, "無內嵌字型.pdf")) });
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}`, n, { timeout: 20000 });
const inkPixels = (p, page) => p.evaluate((page) => {
  const c = document.querySelector(`.page[data-page-number="${page}"] .ink-layer__pen`);
  if (!c) return -1;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n;
}, page);
const waitInk = (p, page, fn, label) => p.waitForFunction(([page, src]) => {
  const c = document.querySelector(`.page[data-page-number="${page}"] .ink-layer__pen`);
  if (!c) return false;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
  return new Function("n", `return ${src}`)(n);
}, [page, fn], { timeout: 15000 }).then(() => true, () => { console.log("timeout:", label); return false; });
async function draw(p, page, pts) {
  await p.locator(`.page[data-page-number="${page}"] .ink-input`).waitFor({ state: "attached" });
  const box = await p.locator(`.page[data-page-number="${page}"]`).boundingBox();
  await p.mouse.move(box.x + pts[0][0], box.y + pts[0][1]); await p.mouse.down();
  for (const [x, y] of pts.slice(1)) await p.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await p.mouse.up();
}
const backToLibrary = async (p) => { await p.getByLabel("回到書櫃").click(); await p.getByText("我的筆記本").waitFor(); };

/** A（開著筆記本）邀請 B（在書櫃）加入 */
async function pair(a, b) {
  await a.locator(".reader__connect").click();
  await a.getByRole("button", { name: /邀請另一台裝置|再邀請一台裝置/ }).click();
  const invite = a.getByRole("textbox", { name: "① 把這段邀請碼傳到另一台裝置" });
  await invite.waitFor();
  const offer = await invite.inputValue();
  await b.getByRole("button", { name: "加入其他裝置的筆記本（測試版）" }).click();
  await b.getByRole("textbox", { name: "邀請碼" }).fill(offer);
  await b.getByRole("button", { name: "產生回覆碼" }).click();
  const replyBox = b.getByRole("textbox", { name: "② 把這段回覆碼傳回邀請的裝置貼上" });
  await replyBox.waitFor();
  const answer = await replyBox.inputValue();
  await a.getByRole("textbox", { name: "回覆碼" }).fill(answer);
  await a.getByRole("dialog").getByRole("button", { name: "連線", exact: true }).click();
  await a.getByText(/已連上 .+，開始同步/).waitFor({ timeout: 20000 });
  return { offer, answer };
}

(async () => {
  const browser = await chromium.launch();
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 } }); const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); await p.goto(env.BASE + "/"); await p.getByText("新增空白筆記本").waitFor(); return p; };
  const A = await mk(); const B = await mk();

  // ── A 建立筆記本並寫字 ──
  await A.getByRole("button", { name: "橫線" }).click();
  await waitCount(A, 1);
  await A.keyboard.press("p");
  await draw(A, 1, [[100, 200], [300, 240], [320, 300]]);
  const aInk1 = await inkPixels(A, 1);
  check(aInk1 > 100, "A wrote a stroke", aInk1);

  // ── 配對 ──
  const t0 = Date.now();
  const { offer, answer } = await pair(A, B);
  check(offer.startsWith("GN1o") && answer.startsWith("GN1a"), "codes have the expected prefix");
  check(offer.length < 800 && answer.length < 800, "codes are short enough to paste", [offer.length, answer.length]);
  check(await A.locator(".reader__connect").textContent() === "已連線 1 台", "A toolbar shows 1 device connected");

  // B 自動開啟收到的筆記本
  await waitCount(B, 1);
  check(true, `B opened the received notebook (${Date.now() - t0} ms incl. pairing)`);
  check(await B.locator(".reader__title").textContent() === await A.locator(".reader__title").textContent(), "same title on both");
  check(await waitInk(B, 1, "n > 100", "B initial ink"), "B shows A's earlier stroke");
  check(await B.locator(".reader__connect").textContent() === "已連線 1 台", "B toolbar shows connected");
  await A.getByRole("button", { name: "關閉" }).click();

  // ── 即時同步：A 再畫一筆 → B 看到 ──
  await B.keyboard.press("p");
  const bBefore = await inkPixels(B, 1);
  const t1 = Date.now();
  await draw(A, 1, [[100, 400], [400, 420]]);
  const liveOk = await waitInk(B, 1, `n > ${bBefore + 50}`, "live stroke");
  check(liveOk, `live: A's new stroke appears on B (${Date.now() - t1} ms after pen up incl. drawing)`);
  check(Math.abs((await inkPixels(A, 1)) - (await inkPixels(B, 1))) <= 5, "A and B ink identical", [await inkPixels(A, 1), await inkPixels(B, 1)]);

  // B 畫線 → A 看到
  const aBefore = await inkPixels(A, 1);
  await draw(B, 1, [[150, 550], [450, 600]]);
  check(await waitInk(A, 1, `n > ${aBefore + 50}`, "B→A stroke"), "B's stroke appears on A");

  // B 插入頁面 → A 也變 2 頁
  await B.getByRole("button", { name: "＋ 插入頁面" }).click();
  await B.getByRole("menuitem", { name: "方格" }).click();
  await waitCount(B, 2);
  await waitCount(A, 2);
  check(true, "B inserts a page → A has 2 pages");

  // A 改名稱 → B 更新
  await A.locator(".reader__title").click();
  await A.getByLabel("筆記本名稱").fill("一起寫的筆記");
  await A.getByLabel("筆記本名稱").press("Enter");
  await B.waitForFunction(() => document.querySelector(".reader__title")?.textContent === "一起寫的筆記", null, { timeout: 10000 }).then(() => check(true, "rename syncs to B"), () => check(false, "rename syncs to B"));

  // B 復原：只復原 B 自己的動作（插頁、B 的筆畫），A 的筆畫還在
  await B.locator(".reader__scroll").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await B.keyboard.press("Control+z"); // 復原插頁
  await waitCount(B, 1); await waitCount(A, 1);
  await B.keyboard.press("Control+z"); // 復原 B 的筆畫
  await A.waitForTimeout(800);
  check(Math.abs((await inkPixels(A, 1)) - aBefore) <= 5 && Math.abs((await inkPixels(B, 1)) - aBefore) <= 5, "undo on B only undoes B's own actions; A's strokes remain", [aBefore, await inkPixels(A, 1), await inkPixels(B, 1)]);
  const bRedo = await B.locator('[aria-label^="復原"]').first().isEnabled().catch(() => null);

  // ── 中斷連線 ──
  await A.locator(".reader__connect").click();
  await A.getByRole("button", { name: "中斷" }).click();
  await A.getByRole("button", { name: "關閉" }).click();
  await B.getByText(/的連線已中斷/).waitFor({ timeout: 10000 }).then(() => check(true, "B notified of disconnect"), () => check(false, "B notified of disconnect"));
  check(await B.locator(".reader__connect").textContent() === "連線" && await A.locator(".reader__connect").textContent() === "連線", "both toolbars back to 連線");

  // ── 離線時各自修改，再連線後合併 ──
  await draw(A, 1, [[100, 700], [300, 720]]);
  await draw(B, 1, [[350, 700], [500, 760]]);
  const aOff = await inkPixels(A, 1), bOff = await inkPixels(B, 1);
  await backToLibrary(B);
  check(await B.getByText("一起寫的筆記").count() === 1, "B's library has the notebook (saved on device B)");
  await pair(A, B);
  await waitCount(B, 1);
  await A.getByRole("button", { name: "關閉" }).click();
  await B.waitForTimeout(500);
  check(await waitInk(B, 1, `n > ${bOff + 50}`, "merge on B") && await waitInk(A, 1, `n > ${aOff + 50}`, "merge on A"), "reconnect merges offline edits from both sides");
  check(Math.abs((await inkPixels(A, 1)) - (await inkPixels(B, 1))) <= 5, "after merge A and B identical", [await inkPixels(A, 1), await inkPixels(B, 1)]);
  check((await B.locator(".library__item").count().catch(() => 0)) === 0, "B did not create a duplicate (opened existing)");

  // ── 有 PDF 原檔的筆記本：C 加入後收到 PDF，中文正常顯示 ──
  await backToLibrary(A);
  await A.locator(".drop input[type=file]").setInputFiles(cjk());
  await A.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("中文測試"));
  const C = await mk();
  await pair(A, C);
  await C.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("中文測試"), null, { timeout: 20000 }).then(() => check(true, "C received the PDF file and renders Chinese text"), () => check(false, "C received the PDF file"));
  await A.getByRole("button", { name: "關閉" }).click();
  // B 也加入同一本（A 同時連兩台）
  await backToLibrary(B);
  await pair(A, B);
  await A.waitForFunction(() => document.querySelector(".reader__connect")?.textContent === "已連線 2 台", null, { timeout: 10000 }).then(() => check(true, "A connected to 2 devices"), () => check(false, "A connected to 2 devices"));
  await A.getByRole("button", { name: "關閉" }).click();
  await waitCount(B, 1);
  // C 寫字 → 經過 A 傳到 B
  await C.keyboard.press("p");
  await draw(C, 1, [[100, 300], [400, 330]]);
  check(await waitInk(B, 1, "n > 100", "C→A→B"), "C's stroke reaches B through A");

  // ── 錯誤處理：貼錯碼 ──
  await backToLibrary(C);
  await C.getByRole("button", { name: "加入其他裝置的筆記本（測試版）" }).click();
  await C.getByRole("textbox", { name: "邀請碼" }).fill(answer);
  await C.getByRole("button", { name: "產生回覆碼" }).click();
  check(await C.getByRole("alert").textContent() === "這是「回覆碼」，請貼上另一台裝置的「邀請碼」。", "pasting a reply code where an invite is expected → clear error");
  await C.getByRole("textbox", { name: "邀請碼" }).fill("hello");
  await C.getByRole("button", { name: "產生回覆碼" }).click();
  await C.getByText("這不是連線碼，請確認複製完整。").waitFor({ timeout: 3000 }).then(() => check(true, "garbage code → clear error"), () => check(false, "garbage code → clear error"));
  await C.getByRole("button", { name: "取消" }).click();

  for (const [n, p] of [["A", A], ["B", B], ["C", C]]) check(p.errors.length === 0, `no page errors on ${n}`, p.errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
