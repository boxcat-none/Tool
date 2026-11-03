import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // 相對路徑，方便部署到 GitHub Pages 子路徑，之後也能直接給 Tauri 載入
  base: "./",
  worker: { format: "es" },
});
