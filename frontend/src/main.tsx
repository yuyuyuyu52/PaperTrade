import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TradingPage from "./pages/TradingPage";
import "./styles.css";

const path = window.location.pathname;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {path.startsWith('/trade') ? <TradingPage /> : <App />}
  </React.StrictMode>
);
