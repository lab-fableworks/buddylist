import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Stream } from "./Stream";
import "./stream.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Stream />
  </StrictMode>,
);
