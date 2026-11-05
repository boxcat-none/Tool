import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isDesktop } from "./lib/desktop";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 離線使用：網頁版正式建置才註冊 Service Worker（開發時與軟體版不需要）
if (import.meta.env.PROD && !isDesktop && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // 註冊失敗（例如私密瀏覽）時照常使用，只是不能離線
    });
  });
}
