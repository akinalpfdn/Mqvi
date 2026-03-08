import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./i18n"; // Must be imported before App for i18n initialization
import "./styles/globals.css";
import App from "./App";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import { isElectron } from "./utils/constants";

// Electron uses HashRouter (file:// protocol doesn't support HTML5 History API).
// Web uses BrowserRouter for clean URLs.
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
