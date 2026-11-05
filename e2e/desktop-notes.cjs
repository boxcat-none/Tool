// 軟體版：自動儲存在關閉、重新開啟程式後仍然存在；存成 .guganote
const env = require("./lib/env.cjs");
const fs = require("fs"); const path = require("path");
const W = "http://127.0.0.1:4444"; let sid; let failed = false;
async function wd(m, u, b) { const r = await fetch(W + u, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) }); const j = await r.json(); if (j.value && j.value.error) throw new Error(j.value.message); return j.value; }
const exec = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, t = 30000) { const s = Date.now(); while (Date.now() - s < t) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } throw new Error("timeout " + label); }
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const clickText = (t) => exec(`const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes(arguments[0]) || b.getAttribute("aria-label") === arguments[0]); if (!b) throw new Error("no button " + arguments[0]); b.click();`, [t]);
const count = () => exec(`return document.querySelector(".reader__count")?.textContent`);
const inkPixels = (n) => exec(`const c = document.querySelector('.page[data-page-number="${n}"] .ink-layer__pen'); if (!c) return -1; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) k++; return k;`);
async function startApp() {
  sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: env.DESKTOP_APP } } } })).sessionId;
  await waitFor(() => exec("return document.body.innerText.includes('閱讀與筆記')"), "app");
  await exec(`[...document.querySelectorAll("button")].find((b) => b.textContent === "閱讀與筆記").click()`);
  await waitFor(() => exec("return !!document.querySelector('.library')"), "library");
}
async function draw(n) {
  const el = await wd("POST", `/session/${sid}/element`, { using: "css selector", value: `.page[data-page-number="${n}"] .ink-input` });
  const origin = { "element-6066-11e4-a52e-4f735466cecf": el["element-6066-11e4-a52e-4f735466cecf"] };
  await wd("POST", `/session/${sid}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
    { type: "pointerMove", duration: 0, origin, x: -150, y: -100 }, { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: 150, origin, x: 0, y: -40 }, { type: "pointerMove", duration: 150, origin, x: 150, y: -100 },
    { type: "pointerUp", button: 0 } ] }] });
}
(async () => {
  const OUT = env.out("w4"); fs.mkdirSync(OUT, { recursive: true });
  const savePath = path.join(OUT, "desktop.guganote"); fs.rmSync(savePath, { force: true });
  const title = `桌面測試 ${Date.now() % 100000}`;

  // 第一次啟動：建立筆記本、插頁、寫字
  await startApp();
  await clickText("方格");
  await waitFor(async () => (await count()) === "/ 1", "notebook");
  await exec(`document.querySelector(".reader__title").click()`);
  await waitFor(() => exec(`return !!document.querySelector(".reader__title-input")`), "title input");
  await exec(`const el = document.querySelector(".reader__title-input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, arguments[0]); el.dispatchEvent(new Event("input", { bubbles: true })); el.blur();`, [title]);
  await clickText("＋ 插入頁面"); await clickText("橫線");
  await waitFor(async () => (await count()) === "/ 2", "inserted");
  await exec(`document.querySelector('[aria-label="鋼筆（P）"]').click()`);
  await waitFor(() => exec(`return !!document.querySelector('.page[data-page-number="2"] .ink-input')`), "ink layer p2");
  await draw(2); await sleep(300);
  check(await inkPixels(2) > 100, "desktop: draw on inserted page");
  await exec(`window.__e2e = { save: () => arguments[0] };`, [savePath]);
  await clickText("存成 .guganote");
  await waitFor(() => fs.existsSync(savePath) && fs.statSync(savePath).size > 0, ".guganote saved");
  const head = fs.readFileSync(savePath).subarray(0, 2).toString("latin1");
  check(head === "PK", "desktop: .guganote saved to disk (ZIP)", head);
  await sleep(1500); // 等書櫃資訊寫入
  await wd("DELETE", `/session/${sid}`);

  // 第二次啟動：書櫃裡還在，筆跡還在
  await startApp();
  const listed = await waitFor(() => exec(`const t = [...document.querySelectorAll(".library__item")].map((e) => e.textContent); return t.length ? t : null`), "library list");
  const item = listed.find((t) => t.includes(title));
  check(!!item && item.includes("2 頁"), "desktop: notebook still in library after restart", item);
  await exec(`[...document.querySelectorAll(".library__open")].find((b) => b.textContent.includes(arguments[0])).click()`, [title]);
  await waitFor(async () => (await count()) === "/ 2", "reopened");
  await exec(`const i = document.querySelector(".reader__page"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "2"); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`);
  await waitFor(async () => (await inkPixels(2)) > 100, "ink after restart", 15000).catch(() => {});
  check(await inkPixels(2) > 100, "desktop: strokes still there after restart", await inkPixels(2));
  fs.writeFileSync(path.join(env.out("shots"), "desktop-notes.png"), Buffer.from(await wd("GET", `/session/${sid}/screenshot`), "base64"));
  await wd("DELETE", `/session/${sid}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("ERROR", e.message); try { await wd("DELETE", `/session/${sid}`); } catch {} process.exit(1); });
