import "./index.css";

import App from "./App.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

if (typeof chrome !== "undefined" && chrome.i18n) {
  document.title =
    chrome.i18n.getMessage("optionsTitle") || "Tab Group Dedup Manager";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
