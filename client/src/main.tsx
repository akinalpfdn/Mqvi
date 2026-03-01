import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./i18n"; // i18n initialization — import order matters, must be before App
import "./styles/globals.css";
import App from "./App";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import { isElectron } from "./utils/constants";

/**
 * Router seçimi:
 * - Web (browser): BrowserRouter → clean URL'ler (/login, /channels)
 * - Electron: HashRouter → hash-based URL'ler (#/login, #/channels)
 *
 * Neden? Electron production'da file:// protokolü kullanılır.
 * BrowserRouter HTML5 History API'ye dayanır ve file:// ile çalışmaz —
 * route eşleşmesi yapamaz, beyaz ekran verir.
 * HashRouter URL fragment'ları (#) kullandığı için her protokolde çalışır.
 */
const Router = isElectron() ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Router>
        <App />
      </Router>
    </ErrorBoundary>
  </StrictMode>
);
