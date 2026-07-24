import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { makeQueryClient } from "../data/errors";
import { startRealtime } from "../data/realtime";
import { App } from "./App";

// QueryClient con el reporte central de errores cableado (src/data/errors.ts).
const queryClient = makeQueryClient();

/** Suscribe Realtime → invalidación de keys; cleanup al desmontar. */
function RealtimeBridge() {
  const qc = useQueryClient();
  useEffect(() => startRealtime(qc), [qc]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RealtimeBridge />
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
