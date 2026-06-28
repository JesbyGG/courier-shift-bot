import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { Toaster } from "sonner";
import App from "./App";
import { MeProvider } from "./state/MeContext";
import { initTelegram } from "./telegram";
import "./styles.css";

initTelegram();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MeProvider>
      <HashRouter>
        <App />
        <Toaster
          position="top-center"
          theme="dark"
          richColors
          toastOptions={{
            style: {
              background: "rgba(20,20,32,0.92)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#f3f3fb",
              backdropFilter: "blur(12px)",
            },
          }}
        />
      </HashRouter>
    </MeProvider>
  </React.StrictMode>,
);
