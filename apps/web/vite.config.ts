import react from "@vitejs/plugin-react";
import { cpSync, createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * pdf.js 需要的資源檔：
 * - cmaps：中文等字型對照表（PDF 沒有內嵌字型時，沒有它中文字會整個消失）
 * - standard_fonts：PDF 標準 14 字型
 * - wasm：JPEG 2000、JBIG2 圖片解碼器
 * - iccs：色彩描述檔
 * 開發時直接提供、建置時複製到 dist/pdfjs/。
 * 不包含 quickjs（執行 PDF 內嵌 JavaScript 用，我們不啟用）。
 */
function pdfjsAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const wanted = (path: string) => !basename(path).startsWith("quickjs");
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "").split("?")[0])).replace(/^([/\\])+/, "");
        const [dir] = rel.split(/[/\\]/);
        const file = join(root, rel);
        if (!dirs.includes(dir) || !file.startsWith(root) || !wanted(file) || !existsSync(file) || !statSync(file).isFile()) {
          return next();
        }
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      const out = options.dir ?? "dist";
      for (const d of dirs) cpSync(join(root, d), join(out, "pdfjs", d), { recursive: true, filter: wanted });
    },
  };
}

/**
 * 離線用的 Service Worker（dist/sw.js）。建置時把所有程式檔列進「預先快取」清單；
 * pdf.js 的字型對照表等資源很多（3.6 MB），用到才快取。
 * 版本號由檔案清單的雜湊決定，程式更新後舊快取會被清掉。
 */
function serviceWorker(): Plugin {
  return {
    name: "service-worker",
    apply: "build",
    writeBundle(options) {
      const out = options.dir ?? "dist";
      const files: string[] = [];
      const walk = (dir: string, prefix = "") => {
        for (const name of readdirSync(join(out, dir))) {
          const rel = prefix ? `${prefix}/${name}` : name;
          if (statSync(join(out, dir, name)).isDirectory()) {
            if (rel !== "pdfjs") walk(join(dir, name), rel);
          } else if (rel !== "sw.js" && !rel.endsWith(".map")) {
            files.push(rel);
          }
        }
      };
      walk("");
      files.sort();
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "src/sw-template.js"), "utf8");
      writeFileSync(
        join(out, "sw.js"),
        template.replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(files.map((f) => (f === "index.html" ? "./" : f)))),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), serviceWorker()],
  // 相對路徑，方便部署到 GitHub Pages 子路徑，也能直接給 Tauri 載入
  base: "./",
  worker: { format: "es" },
});
