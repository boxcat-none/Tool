// W8：對方正在畫、還沒放開的筆畫即時顯示；對方正在看第幾頁
const env = require("./lib/env.cjs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}`, n, { timeout: 20000 });
const pixels = (p, page, cls) => p.evaluate(([page, cls]) => {
  const c = document.querySelector(`.page[data-page-number="${page}"] .${cls}`);
  if (!c || !c.width) return -1;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n;
}, [page, cls]);
const waitPixels = (p, page, cls, cond, ms = 5000) => p.waitForFunction(([page, cls, cond]) => {
  const c = document.querySelector(`.page[data-page-number="${page}"] .${cls}`);
  if (!c || !c.width) return false;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
  return new Function("n", `return ${cond}`)(n);
}, [page, cls, cond], { timeout: ms }).then(() => true, () => false);
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
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 } }); const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); await p.goto(env.BASE + "/"); await p.getByText("新增空白筆記本").waitFor(); return p; };
  const A = await mk(); const B = await mk();
  await A.getByRole("button", { name: "橫線" }).click();
  await waitCount(A, 1);
  await A.getByRole("button", { name: "＋ 插入頁面" }).click();
  await A.getByRole("menuitem", { name: "方格" }).click();
  await waitCount(A, 2);
  await A.locator(".reader__page").fill("1"); await A.locator(".reader__page").press("Enter");
  await pair(A, B);
  await waitCount(B, 2);

  // ── 正在畫的筆畫 ──
  await A.keyboard.press("p");
  await A.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" });
  const box = await A.locator('.page[data-page-number="1"]').boundingBox();
  await A.mouse.move(box.x + 100, box.y + 200); await A.mouse.down();
  await A.mouse.move(box.x + 250, box.y + 230, { steps: 10 });
  const t = Date.now();
  const seen = await waitPixels(B, 1, "ink-layer__remote", "n > 100");
  check(seen, `B sees A's stroke while A is still drawing (${Date.now() - t} ms)`, await pixels(B, 1, "ink-layer__remote"));
  check(await pixels(B, 1, "ink-layer__pen") === 0, "…and it is not saved into B's notebook yet");
  const before = await pixels(B, 1, "ink-layer__remote");
  await A.mouse.move(box.x + 400, box.y + 300, { steps: 10 });
  check(await waitPixels(B, 1, "ink-layer__remote", `n > ${before + 50}`), "the live stroke grows as A keeps drawing");
  await A.mouse.up();
  check(await waitPixels(B, 1, "ink-layer__pen", "n > 100") && await waitPixels(B, 1, "ink-layer__remote", "n === 0"), "on pen up: stroke saved on B, live preview cleared");
  check(Math.abs((await pixels(A, 1, "ink-layer__pen")) - (await pixels(B, 1, "ink-layer__pen"))) <= 5, "final stroke identical on both", [await pixels(A, 1, "ink-layer__pen"), await pixels(B, 1, "ink-layer__pen")]);
  check(await pixels(A, 1, "ink-layer__remote") === 0, "A does not see its own stroke as remote");

  // 螢光筆
  await A.keyboard.press("h");
  await A.mouse.move(box.x + 100, box.y + 500); await A.mouse.down();
  await A.mouse.move(box.x + 400, box.y + 510, { steps: 10 });
  check(await waitPixels(B, 1, "ink-layer__remote", "n > 100"), "highlighter live preview also shows");
  await A.mouse.up();
  check(await waitPixels(B, 1, "ink-layer__remote", "n === 0") && await waitPixels(B, 1, "ink-layer__highlight", "n > 100"), "highlighter saved on B after pen up");

  // 斷線時正在畫 → 對方的預覽會清掉
  await A.keyboard.press("p");
  await A.mouse.move(box.x + 100, box.y + 650); await A.mouse.down();
  await A.mouse.move(box.x + 300, box.y + 660, { steps: 8 });
  await waitPixels(B, 1, "ink-layer__remote", "n > 100");
  // ── 對方在第幾頁 ──（先放開，避免影響）
  await A.mouse.up();
  await A.locator(".reader__page").fill("2"); await A.locator(".reader__page").press("Enter");
  await B.waitForFunction(() => document.querySelector(".reader__connect")?.title.includes("第 2 頁"), null, { timeout: 5000 }).then(() => check(true, "B's toolbar shows A is on page 2"), async () => check(false, "B's toolbar shows A is on page 2", await B.locator(".reader__connect").getAttribute("title")));
  await B.locator(".reader__connect").click();
  await B.getByRole("button", { name: "正在看第 2 頁" }).click();
  await B.waitForFunction(() => document.querySelector(".reader__page")?.value === "2", null, { timeout: 5000 }).then(() => check(true, "click → B jumps to A's page"), () => check(false, "click → B jumps to A's page"));

  // 斷線：預覽與頁碼資訊清掉
  await A.mouse.move(box.x + 100, box.y + 300);
  await A.locator(".reader__connect").click();
  await A.getByRole("button", { name: "中斷" }).click();
  await B.waitForFunction(() => document.querySelector(".reader__connect")?.textContent === "連線", null, { timeout: 5000 });
  check(await B.locator(".reader__connect").getAttribute("title") === "和其他裝置同時編輯這本筆記本", "after disconnect presence cleared");

  for (const [n, p] of [["A", A], ["B", B]]) check(p.errors.length === 0, `no page errors on ${n}`, p.errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
