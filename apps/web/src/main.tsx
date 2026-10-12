import React from "react";
import { createRoot } from "react-dom/client";
import { SafeApp } from "./App";
import { Toaster } from "@/components/ui/sonner";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SafeApp />
    <Toaster />
  </React.StrictMode>
);
