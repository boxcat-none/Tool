const env = require("./lib/env.cjs");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument } = require(env.PDF_LIB);
const { unzipSync } = require(env.FFLATE);

const dir = env.out("run");
const fx = env.out("run-fixtures");
const shots = env.out("shots");
fs.mkdirSync(shots, { recursive: true });

async function makePdf(name, markers) {
  const doc = await PDFDocument.create();
  for (const m of markers) doc.addPage([100 + m, 200]);
  fs.writeFileSync(path.join(fx, name), await doc.save());
  return path.join(fx, name);
}
async function markers(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getWidth()) - 100);
}
function up(paths) {
  // Playwright 以路徑上傳多個非 ASCII 檔名時會漏檔，改用 buffer 上傳
  return [].concat(paths).map((f) => ({
    name: path.basename(f),
    mimeType: f.endsWith(".pdf") ? "application/pdf" : "text/plain",
    buffer: fs.readFileSync(f),
  }));
}
function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : " expected " + JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const a = await makePdf("A報告.pdf", [1, 2]);
  const b = await makePdf("B附件.pdf", [3]);
  const c = await makePdf("C.pdf", [4, 5, 6]);
  const five = await makePdf("五頁文件.pdf", [1, 2, 3, 4, 5]);
  const txt = path.join(fx, "notes.txt"); fs.writeFileSync(txt, "hello");
  const broken = path.join(fx, "壞掉.pdf"); fs.writeFileSync(broken, "%PDF-garbage");

  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(env.BASE + "/#merge");

  // ── 合併 ──
  await page.locator(".drop input[type=file]").setInputFiles(up([a, b, c]));
  await page.getByText("共 6 頁").waitFor();
  // 把 C 往上移到第一個
  await page.getByLabel("把 C.pdf 往上移").click();
  await page.getByLabel("把 C.pdf 往上移").click();
  const order = await page.locator(".file__name").allTextContents();
  assertEq(order, ["C.pdf", "A報告.pdf", "B附件.pdf"], "merge order after moving");
  await page.screenshot({ path: path.join(shots, "merge.png") });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "合併並下載" }).click()]);
  assertEq(dl.suggestedFilename(), "合併.pdf", "merge filename");
  assertEq(await markers(fs.readFileSync(await dl.path())), [4, 5, 6, 1, 2, 3], "merged pages");
  await page.locator(".status--done").waitFor();
  assertEq(await page.locator(".status--done").textContent() !== null, true, "merge done message");

  // 錯誤檔案
  await page.locator(".drop input[type=file]").setInputFiles(up([txt, broken]));
  await page.getByText("不是有效的 PDF").waitFor();
  assertEq(await page.getByText("不是 PDF 檔案").count(), 1, "non-pdf flagged");
  assertEq(await page.getByRole("button", { name: "合併並下載" }).isDisabled(), true, "merge disabled with bad files");
  await page.screenshot({ path: path.join(shots, "merge-errors.png") });

  // ── 分割 ──
  await page.getByRole("tab", { name: "分割 PDF" }).click();
  await page.locator(".drop input[type=file]").setInputFiles(up(five));
  await page.getByText("5 頁", { exact: false }).first().waitFor();
  const range = page.getByPlaceholder("例如：1-3, 4-6, 7-");
  await range.fill("1-2, 9");
  await page.getByText("頁碼 9 超出範圍").waitFor();
  assertEq(await page.getByRole("button", { name: /分割並下載/ }).isDisabled(), true, "split disabled on bad range");
  await range.fill("1-2，5、3-");
  await page.getByText("將產生 3 個檔案").waitFor();
  await page.screenshot({ path: path.join(shots, "split.png") });
  let [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "分割並下載 ZIP" }).click()]);
  assertEq(dl2.suggestedFilename(), "五頁文件_分割.zip", "split zip name");
  const zip = unzipSync(new Uint8Array(fs.readFileSync(await dl2.path())));
  const names = Object.keys(zip);
  assertEq(names, ["五頁文件_p1-2.pdf", "五頁文件_p5.pdf", "五頁文件_p3-5.pdf"], "zip entries");
  assertEq(await Promise.all(names.map((n) => markers(zip[n]))), [[1, 2], [5], [3, 4, 5]], "split pages");

  // 擷取 → 單一 PDF
  await page.getByText("擷取頁面").click();
  await page.getByPlaceholder("例如：1, 3, 5-8").fill("5, 1-2");
  [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "分割並下載" }).click()]);
  assertEq(dl2.suggestedFilename(), "五頁文件_擷取.pdf", "extract name");
  assertEq(await markers(fs.readFileSync(await dl2.path())), [5, 1, 2], "extract pages");

  // 每 N 頁
  await page.getByText("每 N 頁一份").click();
  await page.getByLabel("每份頁數").fill("2");
  await page.getByText("將產生 3 個檔案").waitFor();
  [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "分割並下載 ZIP" }).click()]);
  const zip2 = unzipSync(new Uint8Array(fs.readFileSync(await dl2.path())));
  assertEq(await Promise.all(Object.values(zip2).map((d) => markers(d))), [[1, 2], [3, 4], [5]], "every 2 pages");

  // 手機寬度 + 深色模式截圖
  const mobile = await browser.newPage({ viewport: { width: 375, height: 760 }, colorScheme: "dark" });
  await mobile.goto(env.BASE + "/#merge");
  await mobile.locator(".drop input[type=file]").setInputFiles(up([a, b, c]));
  await mobile.getByText("共 6 頁").waitFor();
  await mobile.screenshot({ path: path.join(shots, "mobile-dark.png"), fullPage: true });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assertEq(overflow, false, "no horizontal scroll at 375px");

  assertEq(errors, [], "no console/page errors");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
