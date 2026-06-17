import React from "react";
import ReactDOM from "react-dom/client";
import { Providers } from "./providers";
import { App } from "./App";
import { Authorize } from "./Authorize";
import "./styles.css";

// Tiny path switch: /oauth/authorize is the standalone Stytch consent page
// (no Sui/Enoki providers); everything else is the onboarding app.
const isAuthorize = window.location.pathname.startsWith("/oauth/authorize");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isAuthorize ? (
      <Authorize />
    ) : (
      <Providers>
        <App />
      </Providers>
    )}
  </React.StrictMode>,
);
