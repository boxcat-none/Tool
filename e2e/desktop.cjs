// 用 tauri-driver（WebDriver）實際操作軟體版
const env = require("./lib/env.cjs");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require(env.PDF_LIB);

const APP = env.DESKTOP_APP;
const SRC = path.join(env.FIX, "office");
const WORK = env.out("desktop-work");
const shots = env.out("shots");
const W = "http://127.0.0.1:4444";
let sid, failed = false;

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : " expected " + JSON.stringify(expected)}`);
  if (!ok) failed = true;
}
async function wd(method, url, body) {
  const r = await fetch(W + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${url}: ${j.value.error} ${j.value.message}`);
  return j.value;
}
const exec = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
const execAsync = (script, args = []) => wd("POST", `/session/${sid}/execute/async`, { script, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(250);
  }
  throw new Error("timeout: " + label);
}
const bodyText = () => exec("return document.body.innerText");
const waitText = (t, timeout) => waitFor(async () => (await bodyText()).includes(t), t, timeout);
/** 點擊含有指定文字的按鈕 */
const clickButton = (text) => exec(`
  const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === arguments[0] || b.textContent.trim().startsWith(arguments[0]));
  if (!b) throw new Error("no button " + arguments[0]); b.click();`, [text]);
/** 把本機檔案塞進頁面上的 file input（模擬拖放／選檔） */
const injectFiles = (files) => exec(`
  const input = document.querySelector(".panel .drop input[type=file]");
  const dt = new DataTransfer();
  for (const f of arguments[0]) {
    const bin = atob(f.b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));`,
  [files.map((f) => ({ name: path.basename(f.path), type: f.type, b64: fs.readFileSync(f.path).toString("base64") }))]);
async function screenshot(name) {
  const b64 = await wd("GET", `/session/${sid}/screenshot`);
  fs.writeFileSync(path.join(shots, name), Buffer.from(b64, "base64"));
}
async function pdfPages(p) { return (await PDFDocument.load(fs.readFileSync(p))).getPageCount(); }

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, "原檔"), { recursive: true });
  fs.mkdirSync(path.join(WORK, "輸出"), { recursive: true });
  for (const f of ["報告.docx", "銷售.xlsx", "簡報.pptx", "壞掉.docx"]) fs.copyFileSync(path.join(SRC, f), path.join(WORK, "原檔", f));

  sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: APP } } } })).sessionId;
  await wd("POST", `/session/${sid}/window/rect`, { width: 1000, height: 780 }).catch(() => {});
  await waitText("PDF 工具箱");

  // 測試建置（VITE_E2E=1）的對話框改由 window.__e2e 提供結果；其餘 IPC 照常送到 Rust
  await exec(`
    window.__dlg = { files: [], folder: null, save: null, noOffice: false, calls: [] };
    const log = (cmd, arg) => window.__dlg.calls.push({ cmd, arg });
    window.__e2e = {
      pickFiles: (ext) => (log("pickFiles", ext), window.__dlg.files),
      pickFolder: (t) => (log("pickFolder", t), window.__dlg.folder),
      save: (n) => (log("save", n), window.__dlg.save),
      reveal: (p) => log("reveal", p),
      openUrl: (u) => log("openUrl", u),
      officeStatus: () => (window.__dlg.noOffice ? { soffice: null, extensions: [] } : undefined),
    };`);

  // 程式預設進入「閱讀與筆記」，先切到 PDF 工具
  await exec(`[...document.querySelectorAll("button")].find((b) => b.textContent === "PDF 工具").click()`);
  await waitFor(() => exec(`return document.querySelectorAll("[role=tab]").length > 0`), "tools tabs");
  const tabs = await exec(`return [...document.querySelectorAll("[role=tab]")].map((t) => t.textContent)`);
  assertEq(tabs.includes("Office 轉 PDF"), true, "desktop shows Office tab");
  assertEq((await bodyText()).includes("所有處理都在你的電腦上完成"), true, "desktop privacy text");

  // ── 沒有 LibreOffice 時的提示 ──
  await exec("window.__dlg.noOffice = true");
  await clickButton("Office 轉 PDF");
  await waitText("需要先安裝 LibreOffice");
  await screenshot("desktop-no-office.png");
  await clickButton("前往下載 LibreOffice");
  const opened = await exec(`return window.__dlg.calls.find((c) => c.cmd === "openUrl")?.arg`);
  assertEq(opened, "https://www.libreoffice.org/download/download-libreoffice/", "download link opened");
  await exec("window.__dlg.noOffice = false");
  await clickButton("重新偵測");
  await waitText("拖放檔案到這裡");

  // ── 選擇檔案 → 轉換到原檔旁邊 ──
  const picked = ["報告.docx", "銷售.xlsx", "簡報.pptx", "壞掉.docx"].map((f) => path.join(WORK, "原檔", f));
  await exec("window.__dlg.files = arguments[0]", [picked]);
  await exec(`document.querySelector(".panel .drop").click()`);
  await waitText("4 個檔案");
  await clickButton("開始轉換（4 個）");
  await waitFor(async () => /完成！|個成功/.test(await bodyText()), "conversion finished", 240000);
  await screenshot("desktop-office-done.png");
  const statusText = await exec(`return document.querySelector(".status")?.textContent`);
  console.log("     status:", statusText);
  for (const n of ["報告", "銷售", "簡報"]) {
    const out = path.join(WORK, "原檔", `${n}.pdf`);
    assertEq(fs.existsSync(out) && (await pdfPages(out)) > 0, true, `${n}.pdf created next to source`);
  }
  console.log("     壞掉.docx →", fs.existsSync(path.join(WORK, "原檔", "壞掉.pdf")) ? "LibreOffice 把它當純文字轉出來了" : "轉換失敗（有顯示錯誤）");

  await clickButton("在資料夾中顯示");
  const revealed = await exec(`return window.__dlg.calls.find((c) => c.cmd === "reveal")?.arg`);
  assertEq(revealed, path.join(WORK, "原檔", "報告.pdf"), "reveal in folder");

  // ── 拖放檔案 → 必須存到指定資料夾 ──
  await clickButton("全部清除");
  await injectFiles([{ path: path.join(SRC, "報告.docx"), type: "" }]);
  await waitText("拖放進來的檔案無法得知原本的位置");
  await exec("window.__dlg.folder = arguments[0]", [path.join(WORK, "輸出")]);
  await clickButton("開始轉換（1 個）");
  await waitText("完成！1 個檔案已轉成 PDF", 120000);
  assertEq(fs.readdirSync(path.join(WORK, "輸出")), ["報告.pdf"], "dropped file converted into chosen folder");
  const leftover = fs.readdirSync(require("os").tmpdir()).filter((d) => d.startsWith("tool-drop-"))
    .flatMap((d) => fs.readdirSync(path.join(require("os").tmpdir(), d)));
  assertEq(leftover, [], "temp copy removed after success");

  // ── 其他工具在軟體版用原生存檔 ──
  await clickButton("合併 PDF");
  const pdfA = path.join(WORK, "原檔", "報告.pdf"), pdfB = path.join(WORK, "原檔", "簡報.pdf");
  await injectFiles([{ path: pdfA, type: "application/pdf" }, { path: pdfB, type: "application/pdf" }]);
  await waitText("2 個檔案 · 共");
  const mergedPath = path.join(WORK, "輸出", "合併 結果.pdf");
  await exec("window.__dlg.save = arguments[0]", [mergedPath]);
  await clickButton("合併並下載");
  await waitText("已儲存到");
  assertEq(await pdfPages(mergedPath), (await pdfPages(pdfA)) + (await pdfPages(pdfB)), "merged file saved via dialog");

  // 使用者在存檔對話框按取消
  await exec("window.__dlg.save = null");
  await clickButton("合併並下載");
  await sleep(800);
  assertEq(await exec(`return document.querySelector(".status")?.textContent ?? null`), null, "cancel save → no status");

  // 分割成多個檔案 → 存到資料夾（不覆蓋同名檔）
  await clickButton("分割 PDF");
  await injectFiles([{ path: mergedPath, type: "application/pdf" }]);
  await waitText("分割方式");
  await exec(`[...document.querySelectorAll("label.mode")].find((l) => l.textContent.includes("每頁一個檔案")).click()`);
  const splitDir = path.join(WORK, "分割");
  fs.mkdirSync(splitDir);
  await exec("window.__dlg.folder = arguments[0]", [splitDir]);
  await clickButton("分割並下載");
  await waitText("個檔案儲存到");
  assertEq(fs.readdirSync(splitDir).length, await pdfPages(mergedPath), "split files written to folder");
  await clickButton("分割並下載");
  await waitFor(async () => fs.readdirSync(splitDir).length === 2 * (await pdfPages(mergedPath)), "second split");
  assertEq(fs.readdirSync(splitDir).some((n) => n.includes("(2)")), true, "no overwrite on second save");

  // 縮圖（pdf.js worker + CSP）在軟體版能正常運作
  await clickButton("整理頁面");
  await injectFiles([{ path: mergedPath, type: "application/pdf" }]);
  await waitFor(() => exec(`return document.querySelectorAll(".page__frame img").length > 0`), "thumbnails", 30000);
  await screenshot("desktop-organize.png");
  assertEq(true, true, "thumbnails render in desktop webview");

  await wd("DELETE", `/session/${sid}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error("ERROR", e.message);
  try { await screenshot("desktop-error.png"); console.error((await bodyText()).slice(0, 600)); } catch {}
  try { await wd("DELETE", `/session/${sid}`); } catch {}
  process.exit(1);
});
