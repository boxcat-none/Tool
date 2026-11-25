// 心智圖 AI 產生：連到自己的模型（OpenAI 相容 API，用 Playwright 攔截模擬）、架構圖、流程圖、Mermaid 回答、文件與圖片輸入、不用 AI 照標題轉換、錯誤訊息
const fs = require("fs");
const path = require("path");
const env = require("./lib/env.cjs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const OUT = env.out("mindmap-ai");

const MIND = { title: "請假", root: { text: "請假制度", children: [{ text: "申請", children: [{ text: "填假單" }, { text: "附證明" }] }, { text: "核准", children: [{ text: "主管" }] }] } };
const FLOW = {
  title: "請假流程",
  nodes: [
    { id: "s", text: "開始", type: "start" },
    { id: "a", text: "填寫假單", type: "process" },
    { id: "d", text: "主管同意？", type: "decision" },
    { id: "o", text: "通知人資", type: "io" },
    { id: "e", text: "結束", type: "end" },
  ],
  edges: [{ from: "s", to: "a" }, { from: "a", to: "d" }, { from: "d", to: "o", label: "是" }, { from: "d", to: "a", label: "否" }, { from: "o", to: "e" }],
};
const MERMAID = "好的：\n```mermaid\nflowchart TD\n  A([開始]) --> B[收件]\n  B --> C{資料齊全？}\n  C -->|是| D[歸檔]\n  C -->|否| B\n  D --> E((結束))\n```";

const texts = (p) => p.$$eval(".mm-nodes [data-node]", (els) => els.map((g) => g.querySelector("text").textContent.trim()));
async function outline(p) {
  const [d] = await Promise.all([p.waitForEvent("download"), p.getByLabel("匯出").selectOption({ label: "Markdown 大綱" })]);
  const f = path.join(OUT, d.suggestedFilename());
  await d.saveAs(f);
  return fs.readFileSync(f, "utf8");
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ── 模擬的模型伺服器 ──
  const requests = [];
  let answer = null; // null = 依架構圖／流程圖回答 JSON
  let rejectJsonMode = false;
  let down = false;
  await page.route("**/v1/models", (r) => (down ? r.abort("connectionrefused") : r.fulfill({ json: { object: "list", data: [{ id: "my-model" }, { id: "other" }] } })));
  await page.route("**/v1/chat/completions", async (r) => {
    if (down) return r.abort("connectionrefused");
    const body = JSON.parse(r.request().postData());
    requests.push(body);
    if (rejectJsonMode && body.response_format) return r.fulfill({ status: 400, json: { error: { message: "response_format not supported" } } });
    const flow = JSON.stringify(body.messages[0].content).includes("流程圖");
    const content = answer ?? JSON.stringify(flow ? FLOW : MIND);
    return r.fulfill({ json: { choices: [{ message: { role: "assistant", content } }] } });
  });

  await page.goto(env.BASE + "/#mindmap");
  const openDialog = async () => {
    await page.getByRole("button", { name: "AI 產生…" }).click();
    return page.getByRole("dialog", { name: "AI 產生架構圖或流程圖" });
  };
  let dlg = await openDialog();
  check(await dlg.isVisible(), "AI dialog opens from the list");
  check(await dlg.getByLabel("模型伺服器網址").isVisible(), "model settings are open when no model is set yet");

  // ── 測試連線：列出模型，自動填第一個 ──
  await dlg.getByLabel("模型伺服器網址").fill("http://localhost:11434");
  check((await dlg.locator(".mm-ai__hint").filter({ hasText: "送到" }).textContent()).includes("http://localhost:11434/v1"), "a bare host gets /v1 appended");
  await dlg.getByRole("button", { name: "測試連線" }).click();
  await dlg.getByRole("status").filter({ hasText: "連線成功" }).waitFor();
  check((await dlg.getByRole("status").textContent()).includes("2 個模型") && (await dlg.getByLabel("模型名稱").inputValue()) === "my-model", "test connection lists models and fills the first one");

  // ── 文字 → 架構圖 ──
  await dlg.getByLabel("要轉換的文字").fill("員工請假要先填假單並附證明，再由主管核准。");
  await dlg.getByRole("button", { name: "產生" }).click();
  await page.locator(".mm-canvas").waitFor();
  const req = requests.at(-1);
  check(req.model === "my-model" && req.response_format?.type === "json_object" && JSON.stringify(req.messages).includes("員工請假"), "request goes to the model with the text, asking for JSON", { model: req.model });
  check((await outline(page)) === "# 請假制度\n- 申請\n  - 填假單\n  - 附證明\n- 核准\n  - 主管\n", "mind map built from the model's answer");
  check((await page.getByLabel("心智圖標題").inputValue()) === "請假", "title comes from the answer");
  await page.getByRole("button", { name: "回到心智圖清單" }).click();

  // ── 文字 → 流程圖（設定記住了）──
  dlg = await openDialog();
  check((await dlg.locator("summary").textContent()).includes("my-model"), "settings are remembered on this device");
  await dlg.getByLabel("流程圖").check();
  check(await dlg.getByLabel("不用 AI：照標題、清單與段落轉換").isDisabled(), "flowcharts always need the model");
  await dlg.getByLabel("要轉換的文字").fill("填假單，主管同意就通知人資，不同意重填。");
  await dlg.getByRole("button", { name: "產生" }).click();
  await page.locator(".mm-canvas").waitFor();
  await page.waitForTimeout(300);
  const flowTexts = await texts(page);
  check(["開始", "填寫假單", "主管同意？", "通知人資", "結束"].every((t) => flowTexts.includes(t)) && flowTexts.length === 5, "flowchart has every step", flowTexts);
  check((await page.locator(".mm-edges [data-arrow]").count()) === 5, "every flow line has an arrow head", await page.locator(".mm-edges [data-arrow]").count());
  const labels = await page.$$eval("[data-edge-label] text", (els) => els.map((e) => e.textContent));
  check(labels.includes("是") && labels.includes("否"), "decision lines show 是／否", labels);
  const shapeOf = (t) => page.locator(".mm-nodes [data-node]").filter({ hasText: t }).first().evaluate((g) => g.firstElementChild.tagName + ":" + (g.firstElementChild.getAttribute("d") ?? g.firstElementChild.getAttribute("rx")));
  const decision = await shapeOf("主管同意？");
  check(/^path:M[\d.]+ 0L/.test(decision), "decision is a diamond", decision);
  check(/^path:M[\d.]+ 0H/.test(await shapeOf("通知人資")), "input/output is a parallelogram");
  const ys = {};
  for (const t of ["開始", "填寫假單", "主管同意？", "通知人資", "結束"]) ys[t] = (await page.locator(".mm-nodes [data-node]").filter({ hasText: t }).first().boundingBox()).y;
  check(ys["開始"] < ys["填寫假單"] && ys["填寫假單"] < ys["主管同意？"] && ys["主管同意？"] < ys["通知人資"] && ys["通知人資"] < ys["結束"], "flow is laid out top to bottom", ys);
  // 沒有重疊
  const boxes = await page.$$eval(".mm-nodes [data-node]", (els) => els.map((g) => { const b = g.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }));
  const overlap = boxes.some((a, i) => boxes.some((b, j) => j > i && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]));
  check(!overlap, "flow elements do not overlap");
  const cv = await page.locator(".mm-canvas").boundingBox();
  check(boxes.every(([x, y, w, h]) => x >= cv.x && y >= cv.y && x + w <= cv.x + cv.width && y + h <= cv.y + cv.height), "after the automatic layout the whole flowchart is in view");
  // 往回的線（否）從右邊繞回去，不和往下的線疊在一起
  const backD = await page.locator(".mm-edges path").evaluateAll((ps) => ps.map((p) => p.getAttribute("d")));
  check(backD.some((d) => /^M[\d.-]+ [\d.-]+C/.test(d) && d.split(" ").length > 4), "the loop-back line is drawn");
  await page.screenshot({ path: path.join(OUT, "flow.png") });
  // 排版不在復原裡；「自動排列」= 重新分層排版
  check(await page.getByRole("button", { name: "復原" }).isDisabled(), "initial flow layout is not an undo step");
  check(await page.getByRole("button", { name: "自動排列" }).isEnabled(), "auto arrange is available for flowcharts");
  // 線條選單：箭頭、線上的文字
  await page.locator("[data-edge-label]").filter({ hasText: "是" }).click({ button: "right" });
  check(await page.locator(".mm-menu__title").textContent() === "線條" && await page.getByRole("group", { name: "箭頭" }).count() === 1, "right-click a flow label opens the line menu with arrow options");
  page.once("dialog", (d) => d.accept("同意"));
  await page.getByRole("menuitem", { name: "線上的文字…" }).click();
  check((await page.$$eval("[data-edge-label] text", (els) => els.map((e) => e.textContent))).includes("同意"), "line text can be edited");
  await page.getByRole("button", { name: "回到心智圖清單" }).click();

  // ── 模型回答 Mermaid、伺服器不支援 JSON 模式 ──
  answer = MERMAID;
  rejectJsonMode = true;
  dlg = await openDialog();
  await dlg.getByLabel("流程圖").check();
  await dlg.getByLabel("要轉換的文字").fill("收件流程");
  const before = requests.length;
  await dlg.getByRole("button", { name: "產生" }).click();
  await page.locator(".mm-canvas").waitFor();
  check(requests.length - before === 2 && !requests.at(-1).response_format, "server without JSON mode: retried without it");
  const mt = await texts(page);
  check(["開始", "收件", "資料齊全？", "歸檔", "結束"].every((t) => mt.includes(t)), "a Mermaid answer becomes a flowchart", mt);
  await page.getByRole("button", { name: "回到心智圖清單" }).click();
  answer = null;
  rejectJsonMode = false;

  // ── 文件：Word、PowerPoint、HTML、PDF、筆記本以外的檔案都轉成文字送出 ──
  dlg = await openDialog();
  const fileInput = dlg.locator('input[aria-label="選擇要轉換的檔案"]');
  await fileInput.setInputFiles([path.join(env.FIX, "office", "報告.docx"), path.join(env.FIX, "office", "簡報.pptx"), path.join(env.FIX, "office", "報告.html"), path.join(env.FIX, "目錄.pdf")]);
  await dlg.getByRole("list", { name: "已加入的檔案" }).locator("li").nth(3).waitFor({ timeout: 20000 });
  const items = await dlg.getByRole("list", { name: "已加入的檔案" }).locator("li").allTextContents();
  const counts = items.map((t) => Number((/（([\d,]+) 字）/.exec(t)?.[1] ?? "0").replace(/,/g, "")));
  check(items.length === 4 && counts.every((n) => n > 10), "Word, PowerPoint, HTML and PDF files are read as text", items);
  await dlg.getByRole("button", { name: "產生" }).click();
  await page.locator(".mm-canvas").waitFor();
  const sent = JSON.stringify(requests.at(-1).messages[1].content);
  check(["【報告.docx】", "【簡報.pptx】", "【報告.html】", "【目錄.pdf】"].every((t) => sent.includes(t)), "every file's text is sent to the model");
  await page.getByRole("button", { name: "回到心智圖清單" }).click();
  // 舊版 Office 檔有說明
  dlg = await openDialog();
  await dlg.locator('input[aria-label="選擇要轉換的檔案"]').setInputFiles({ name: "舊.ppt", mimeType: "application/vnd.ms-powerpoint", buffer: Buffer.from("x") });
  check((await dlg.getByRole("alert").textContent()).includes("另存成 .pptx"), "old .ppt files explain how to convert");

  // ── 不用 AI：照 Word 的標題轉換 ──
  await dlg.locator('input[aria-label="選擇要轉換的檔案"]').setInputFiles(path.join(env.FIX, "office", "報告.docx"));
  await dlg.getByLabel("不用 AI：照標題、清單與段落轉換").check();
  const n0 = requests.length;
  await dlg.getByRole("button", { name: "產生" }).click();
  await page.locator(".mm-canvas").waitFor();
  check(requests.length === n0 && (await texts(page)).length >= 2, "without AI: built from the document's headings, no request sent", await texts(page));
  await page.getByRole("button", { name: "回到心智圖清單" }).click();

  // ── 圖片：模型看不懂圖片時說明；勾選後圖片送給模型 ──
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 40; c.height = 30;
    c.getContext("2d").fillRect(5, 5, 10, 10);
    return c.toDataURL("image/png").split(",")[1];
  });
  dlg = await openDialog();
  await dlg.locator('input[aria-label="選擇要轉換的檔案"]').setInputFiles({ name: "白板.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  check((await dlg.getByRole("alert").textContent()).includes("看不懂圖片"), "image needs a vision model");
  if (!(await dlg.getByLabel("模型伺服器網址").isVisible())) await dlg.locator("summary").click();
  await dlg.getByLabel("模型看得懂圖片（多模態）").check();
  await dlg.locator('input[aria-label="選擇要轉換的檔案"]').setInputFiles({ name: "白板.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await dlg.getByRole("list", { name: "已加入的檔案" }).getByText("白板.png（圖片）").waitFor();
  await dlg.getByRole("button", { name: "產生" }).click();
  await page.locator(".mm-canvas").waitFor();
  const parts = requests.at(-1).messages[1].content;
  check(Array.isArray(parts) && parts.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/")), "image is sent to a vision model");
  await page.getByRole("button", { name: "回到心智圖清單" }).click();

  // ── 錯誤：伺服器沒開、沒內容 ──
  dlg = await openDialog();
  await dlg.getByRole("button", { name: "產生" }).click();
  check((await dlg.getByRole("alert").textContent()).includes("請先貼上文字"), "empty content shows a hint");
  down = true;
  await dlg.getByLabel("要轉換的文字").fill("內容");
  await dlg.getByRole("button", { name: "產生" }).click();
  await dlg.getByRole("alert").filter({ hasText: "連不到模型伺服器" }).waitFor();
  check((await dlg.getByRole("alert").textContent()).includes("OLLAMA_ORIGINS"), "connection failure explains how to allow this page");
  await dlg.getByRole("button", { name: "取消" }).click();
  check(await page.getByRole("dialog").count() === 0, "cancel closes the dialog");

  check(errors.length === 0, "no page errors", errors);
  await browser.close();
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("FAIL exception", e);
  process.exit(1);
});
