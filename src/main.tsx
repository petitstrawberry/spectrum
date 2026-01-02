import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const isTauri = typeof window !== 'undefined'
  && ((window as any).__TAURI_INTERNALS__ != null || (window as any).__TAURI__ != null);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  isTauri ? <App /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
