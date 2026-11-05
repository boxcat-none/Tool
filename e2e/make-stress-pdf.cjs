// 產生壓力測試用的 300 頁／約 28 MB PDF（e2e/.out/stress/textbook-300.pdf）：每頁文字、每 10 頁一張照片
// 用法：node e2e/make-stress-pdf.cjs
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const env = require("./lib/env.cjs");
const { PDFDocument, StandardFonts, rgb } = require(env.PDF_LIB);

(async () => {
  if (fs.existsSync(env.STRESS_PDF)) return console.log("已存在：", env.STRESS_PDF);
  // 用瀏覽器的 canvas 產生 30 張有雜訊的 JPEG（雜訊讓檔案大小接近真的照片）
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jpegs = await page.evaluate(() => {
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const out = [];
    for (let i = 0; i < 30; i++) {
      const w = 1600, h = 1000;
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4, n = (rnd() - 0.5) * 80;
        img.data[k] = (x / w) * 153 + n + i * 3; img.data[k + 1] = (y / h) * 153 + n + i * 3; img.data[k + 2] = ((x + y) % 256) * 0.6 + n + i * 3; img.data[k + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      out.push(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
    }
    return out;
  });
  await browser.close();

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const imgs = [];
  for (const b64 of jpegs) imgs.push(await doc.embedJpg(Buffer.from(b64, "base64")));
  const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua physics energy momentum force".split(" ");
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let p = 1; p <= 300; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Chapter ${Math.ceil(p / 20)} - Page ${p}`, { x: 60, y: 790, size: 16, font: bold });
    let y = 760;
    if (p % 10 === 0) {
      page.drawImage(imgs[(p / 10 - 1) % 30], { x: 60, y: 480, width: 475, height: 297 });
      y = 460;
    }
    for (; y > 60; y -= 14) {
      let line = "";
      while (line.length < 85) line += words[Math.floor(rnd() * words.length)] + " ";
      page.drawText(line, { x: 60, y, size: 10.5, font, color: rgb(0.1, 0.1, 0.1) });
    }
  }
  env.out("stress");
  fs.writeFileSync(env.STRESS_PDF, await doc.save());
  console.log("已產生：", env.STRESS_PDF, `${(fs.statSync(env.STRESS_PDF).size / 1048576).toFixed(1)} MB`);
})().catch((e) => { console.error(e); process.exit(1); });
