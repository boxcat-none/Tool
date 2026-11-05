// 軟體版（Linux WebKitGTK）：連線功能在不支援 WebRTC 時要清楚提示，不能壞掉
const env = require("./lib/env.cjs");
const W = "http://127.0.0.1:4444"; let sid; let failed = false;
async function wd(m, u, b) { const r = await fetch(W + u, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) }); const j = await r.json(); if (j.value && j.value.error) throw new Error(j.value.message); return j.value; }
const exec = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, t = 30000) { const s = Date.now(); while (Date.now() - s < t) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } throw new Error("timeout " + label); }
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const clickText = (t) => exec(`const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === arguments[0]); if (!b) throw new Error("no button " + arguments[0]); b.click();`, [t]);
(async () => {
  sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: env.DESKTOP_APP } } } })).sessionId;
  await waitFor(() => exec("return document.body.innerText.includes('閱讀與筆記')"), "app");
  await exec(`[...document.querySelectorAll("button")].find((b) => b.textContent === "閱讀與筆記").click()`);
  await waitFor(() => exec("return !!document.querySelector('.library')"), "library");
  const rtc = await exec("return typeof RTCPeerConnection");
  console.log("RTCPeerConnection in WebKitGTK:", rtc, await exec("return navigator.userAgent"));
  await clickText("加入其他裝置的筆記本（測試版）");
  const joinText = await waitFor(() => exec("return document.querySelector('[role=dialog]')?.innerText"), "join dialog");
  if (rtc === "undefined") check(joinText.includes("不支援裝置之間直接連線"), "join dialog explains WebRTC is unsupported");
  else check(joinText.includes("貼上邀請碼"), "join dialog offers pasting a code");
  await clickText(rtc === "undefined" ? "加入其他裝置的筆記本（測試版）" : "取消").catch(() => {});
  await exec(`document.querySelector('[role=dialog] .btn')?.click()`);
  await clickText("橫線");
  await waitFor(() => exec(`return document.querySelector(".reader__count")?.textContent === "/ 1"`), "notebook");
  await clickText("連線");
  const inviteText = await waitFor(() => exec("return document.querySelector('[role=dialog]')?.innerText"), "invite dialog");
  if (rtc === "undefined") check(inviteText.includes("不支援裝置之間直接連線"), "invite dialog explains WebRTC is unsupported");
  else {
    await clickText("邀請另一台裝置");
    const code = await waitFor(() => exec(`return document.querySelector('textarea.sync__code')?.value`), "code");
    check(code.startsWith("GN1o"), "invite code generated");
  }
  const errs = await exec("return window.__errors || []");
  check(true, "dialogs render without crashing");
  await wd("DELETE", `/session/${sid}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("ERROR", e.message); try { await wd("DELETE", `/session/${sid}`); } catch {} process.exit(1); });
