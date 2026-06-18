import React from "react";
import ReactDOM from "react-dom/client";
import { Providers } from "./providers";
import { App } from "./App";
import { Authorize } from "./Authorize";
import { Bind } from "./Bind";
import "./styles.css";

// Tiny path switch: the Stytch pages (/oauth/authorize consent, /bind linking)
// are standalone (no Sui/Enoki providers); everything else is the onboarding app.
const path = window.location.pathname;
const page = path.startsWith("/oauth/authorize")
  ? <Authorize />
  : path.startsWith("/bind")
    ? <Bind />
    : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {page ?? (
      <Providers>
        <App />
      </Providers>
    )}
  </React.StrictMode>,
);
