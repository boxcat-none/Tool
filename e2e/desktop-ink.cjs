const env = require("./lib/env.cjs");
const fs = require("fs"); const path = require("path"); const { execFileSync } = require("child_process");
const W = "http://127.0.0.1:4444"; let sid; let failed = false;
async function wd(m, u, b) { const r = await fetch(W + u, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) }); const j = await r.json(); if (j.value && j.value.error) throw new Error(j.value.message); return j.value; }
const exec = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, t = 30000) { const s = Date.now(); while (Date.now() - s < t) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } throw new Error("timeout " + label); }
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const click = (sel) => exec(`document.querySelector(arguments[0]).click()`, [sel]);
const inkPixels = () => exec(`const c = document.querySelector('.page[data-page-number="1"] .ink-layer__pen'); if (!c) return -1; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n;`);
(async () => {
  const OUT = env.out("w3"); const outPdf = path.join(OUT, "desktop-export.pdf"); fs.rmSync(outPdf, { force: true });
  sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: env.DESKTOP_APP } } } })).sessionId;
  await waitFor(() => exec("return document.body.innerText.includes('閱讀與筆記')"), "app");
  await exec(`window.__e2e = { save: () => arguments[0] };`, [outPdf]);
  await exec(`[...document.querySelectorAll("button")].find((b) => b.textContent === "閱讀與筆記").click()`);
  await waitFor(() => exec("return !!document.querySelector('.drop input[type=file]')"), "drop");
  await exec(`const input = document.querySelector(".drop input[type=file]"); const bin = atob(arguments[0]); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([bytes], "目錄.pdf", { type: "application/pdf" })); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));`,
    [fs.readFileSync(path.join(env.FIX, "目錄.pdf")).toString("base64")]);
  await sleep(800);
  await exec(`const b = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "建立新的筆記本"); if (b) b.click();`);
  await waitFor(() => exec(`return !!document.querySelector('.page[data-page-number="1"] .ink-input')`), "ink layer");
  await click('[aria-label="鋼筆（P）"]');
  const el = await wd("POST", `/session/${sid}/element`, { using: "css selector", value: '.page[data-page-number="1"] .ink-input' });
  const origin = { "element-6066-11e4-a52e-4f735466cecf": el["element-6066-11e4-a52e-4f735466cecf"] };
  // W3C pointer actions：以頁面中心為原點畫一條折線
  const moves = [[-200, 0], [-120, 40], [-40, -20], [60, 50], [160, 0]];
  await wd("POST", `/session/${sid}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
    { type: "pointerMove", duration: 0, origin, x: moves[0][0], y: moves[0][1] },
    { type: "pointerDown", button: 0 },
    ...moves.slice(1).map(([x, y]) => ({ type: "pointerMove", duration: 120, origin, x, y })),
    { type: "pointerUp", button: 0 },
  ] }] });
  await sleep(300);
  const px = await inkPixels();
  check(px > 100, "desktop: pen stroke drawn in WebKit", px);
  await click('[aria-label="復原（Ctrl+Z）"]'); await sleep(200);
  check(await inkPixels() === 0, "desktop: undo");
  await click('[aria-label="重做（Ctrl+Shift+Z）"]'); await sleep(200);
  check(await inkPixels() === px, "desktop: redo");
  await exec(`[...document.querySelectorAll("button")].find((b) => b.textContent === "匯出 PDF").click()`);
  await waitFor(() => fs.existsSync(outPdf) && fs.statSync(outPdf).size > 0, "export file");
  await waitFor(() => exec("return document.body.innerText.includes('已儲存到')"), "saved toast");
  execFileSync("pdftoppm", ["-r", "50", "-f", "1", "-l", "1", "-png", "-singlefile", outPdf, path.join(OUT, "desktop-export")]);
  const blue = Number(execFileSync("python3", ["-c", `
import numpy as np; from PIL import Image
a = np.asarray(Image.open("${OUT}/desktop-export.png").convert("RGB")).astype(int)
print(int(((a[...,2] > 120) & (a[...,0] < 90) & (a[...,1] < 110)).sum()))`]).toString());
  check(blue > 50, "desktop: exported PDF saved to disk with ink", blue);
  fs.writeFileSync(path.join(env.out("shots"), "desktop-ink.png"), Buffer.from(await wd("GET", `/session/${sid}/screenshot`), "base64"));
  await wd("DELETE", `/session/${sid}`); process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("ERROR", e.message); try { await wd("DELETE", `/session/${sid}`); } catch {} process.exit(1); });
