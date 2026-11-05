// 300 頁大型 PDF（node e2e/make-stress-pdf.cjs 產生）經由 WebRTC 傳給新裝置
const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
(async () => {
  const browser = await chromium.launch();
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 } }); const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); await p.goto(env.BASE + "/"); await p.getByText("新增空白筆記本").waitFor(); return p; };
  const A = await mk(); const B = await mk();
  await A.locator(".drop input[type=file]").setInputFiles({ name: "textbook-300.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(env.STRESS_PDF) });
  await A.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 300", null, { timeout: 60000 });
  await A.locator(".reader__connect").click();
  await A.getByRole("button", { name: "邀請另一台裝置" }).click();
  const offer = await A.getByRole("textbox", { name: "① 把這段邀請碼傳到另一台裝置" }).inputValue();
  await B.getByRole("button", { name: "加入其他裝置的筆記本（測試版）" }).click();
  await B.getByRole("textbox", { name: "邀請碼" }).fill(offer);
  await B.getByRole("button", { name: "產生回覆碼" }).click();
  const answer = await B.getByRole("textbox", { name: "② 把這段回覆碼傳回邀請的裝置貼上" }).inputValue();
  await A.getByRole("textbox", { name: "回覆碼" }).fill(answer);
  const t = Date.now();
  await A.getByRole("dialog").getByRole("button", { name: "連線", exact: true }).click();
  const progress = [];
  const poll = setInterval(async () => { const s = await B.locator(".status--busy").textContent().catch(() => null); if (s && progress[progress.length - 1] !== s) progress.push(s); }, 300);
  await B.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 300", null, { timeout: 120000 });
  clearInterval(poll);
  const ms = Date.now() - t;
  const size = fs.statSync(env.STRESS_PDF).size;
  check(true, `B received ${(size / 1048576).toFixed(1)} MB / 300 pages and opened it in ${ms} ms (${(size / 1048576 / (ms / 1000)).toFixed(1)} MB/s)`);
  check(progress.some((s) => /接收檔案… .+ \/ [\d.]+ MB/.test(s)), "progress shown while receiving", progress.slice(0, 3).concat(progress.slice(-2)));
  check(A.errors.length === 0 && B.errors.length === 0, "no page errors", [A.errors, B.errors]);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
